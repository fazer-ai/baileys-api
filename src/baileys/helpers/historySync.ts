import type { LIDMapping, proto, WAMessageKey } from "@whiskeysockets/baileys";

// Binary fields the client never reads, dropped before the payload reaches the
// wire. They are decoded protobuf `bytes`, so they arrive as Uint8Array and
// JSON.stringify turns each one into an index map (`{"0":255,"1":216,...}`) --
// roughly five bytes of JSON per byte of image. A single history dump with a
// few hundred photos in it is mostly this, and none of it is used: media is
// fetched by message id from /media, and the crypto fields only matter to the
// download the API performs itself.
//
// `url`, `directPath` and `mimetype` are deliberately absent: `url` is read
// back for locations and ad attribution, and the other two are cheap strings.
const STRIP_KEYS: ReadonlySet<string> = new Set([
  "jpegThumbnail",
  "thumbnailSha256",
  "thumbnailEncSha256",
  "fileSha256",
  "fileEncSha256",
  "midQualityFileSha256",
  "mediaKey",
  "scansSidecar",
  "streamingSidecar",
  "firstFrameSidecar",
  "waveform",
  "futureproofBuffer",
  "messageSecret",
  "senderKeyHash",
  "recipientKeyHash",
  "deviceListMetadata",
  "initialHistBootstrapInlinePayload",
]);

function strip(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  // Binary is a leaf: recursing into a Uint8Array would walk one property per
  // byte, which is the cost this whole function exists to avoid.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(strip);
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (STRIP_KEYS.has(key)) {
      continue;
    }
    output[key] = strip(item);
  }
  return output;
}

export function stripHistoryPayload<T>(value: T): T {
  return strip(value) as T;
}

// Splits a history dump into frames of at most `maxBytes` of serialized
// messages, stripping as it goes. A budget rather than a hard ceiling: the
// array punctuation the frame is wrapped in lands on top of it, which is a
// couple of kilobytes on a full frame.
//
// A generator, not an array: the caller awaits a POST between frames, so the
// stripping and sizing of the next frame happens after the event loop has had
// a turn. Bun runs one thread, and a whole dump serialized in one go freezes
// every other session on the instance, not just the one syncing.
//
// Budget is bytes rather than a message count because a text message and a
// photo differ by orders of magnitude. A single message larger than the budget
// still goes out on its own -- there is nothing smaller to split it into.
export function* historyFrames<T>(
  messages: readonly T[],
  maxBytes: number,
): Generator<T[]> {
  let frame: T[] = [];
  let frameBytes = 0;

  for (const message of messages) {
    const stripped = stripHistoryPayload(message);
    const size = Buffer.byteLength(JSON.stringify(stripped) ?? "null", "utf8");

    if (frame.length > 0 && frameBytes + size > maxBytes) {
      yield frame;
      frame = [];
      frameBytes = 0;
    }

    frame.push(stripped);
    frameBytes += size;
  }

  if (frame.length > 0) {
    yield frame;
  }
}

// The chat is done: WhatsApp holds nothing older than what it just sent. Named
// after the protobuf value it comes from,
// `Conversation.EndOfHistoryTransferType.COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY`.
export const NO_MORE_HISTORY = 1;

// The jids of the chats in this dump that WhatsApp flagged as having nothing
// older left, which is the only way it ever says so.
//
// It says it on the answer to an on-demand request and nowhere else: the chat
// records in a bootstrap dump never carry the value. And it is the presence of
// a chat record that carries the meaning -- an answer that still has history
// behind it ships the messages with no chat record at all, so the two cases are
// told apart by whether a record arrived, not by reading a field off one.
export function exhaustedChats(
  chats: { id?: string | null; endOfHistoryTransferType?: number | null }[],
): string[] {
  return chats
    .filter((chat) => chat.endOfHistoryTransferType === NO_MORE_HISTORY)
    .map((chat) => chat.id)
    .filter((id): id is string => Boolean(id));
}

// A history message key holds exactly what the protobuf defines: `remoteJid`,
// `fromMe`, `id`, `participant`. The three fields a live key also carries --
// `addressingMode`, `remoteJidAlt`, `participantAlt` -- are stamped by the live
// decoder from stanza attributes, and a dump has no stanza. So on a
// LID-addressed account every chat in a dump reaches the client as a bare
// `<LID>@lid`, with the phone number nowhere in the payload, and a client that
// reads the address as a number files the LID as one. Measured on a real
// pairing: contacts created with a phone number of `+235085806727321`, which is
// a LID.
//
// The mapping is not missing, only unshipped. WhatsApp sends it in this very
// event -- Baileys distills `lidPnMappings` out of the chat records we drop --
// and stores it in `signalRepository.lidMapping` before emitting. Both are read
// back below to rebuild the live shape.
//
// A message as a history dump carries it. `WAMessageKey` is what its key
// becomes once the three fields above are stamped back on.
interface HistoryMessage {
  key?: WAMessageKey | null;
}

// A jid split into the account it names and the server it lives on, with the
// device and agent suffixes dropped: `5511:3@s.whatsapp.net` and
// `5511@s.whatsapp.net` are one account. The same split `jidDecode` makes,
// minus the domain classification nothing here reads, and done by hand for the
// same reason `historyJid` does it: the shapes involved are two.
function splitJid(jid: string | null | undefined) {
  const [address, server] = (jid ?? "").split("@");
  const user = address?.split(":")[0]?.split("_")[0];
  return user && server ? { user, server } : undefined;
}

// The two servers a LID lives on, `hosted.lid` being the business-hosted form. Both are
// LID domains to `jidDecode`, but not to `isLidUser`, which is a plain `@lid` suffix test
// -- so the mapping store never resolves a hosted LID, while the chat records in a dump do
// carry mappings for one. Marking the address is the half that does not depend on either.
const LID_SERVERS = ["lid", "hosted.lid"];

// The LID user a jid addresses, or undefined when the jid is not a LID.
function lidUser(jid: string | null | undefined): string | undefined {
  const decoded = splitJid(jid);
  return decoded && LID_SERVERS.includes(decoded.server)
    ? decoded.user
    : undefined;
}

// The LIDs this dump addresses a chat or a group author by that the index
// cannot resolve yet, deduplicated: what is left to look up, and the whole of
// it, so the lookup is one batched read rather than one per message. A mature
// chat repeats its own address a thousand times.
export function unresolvedLids(
  messages: readonly HistoryMessage[],
  index: ReadonlyMap<string, string>,
): string[] {
  const lids = new Set<string>();
  for (const { key } of messages) {
    for (const jid of [key?.remoteJid, key?.participant]) {
      const user = jid ? lidUser(jid) : undefined;
      if (jid && user && !index.has(user)) {
        lids.add(jid);
      }
    }
  }
  return [...lids];
}

// The servers a phone-addressed jid lives on, `hosted` being the business-hosted form.
const PHONE_SERVERS = ["s.whatsapp.net", "c.us", "hosted"];

// The LID↔phone pairs the dump's own chat records carry, which is where Baileys reads
// `lidPnMappings` from in the first place.
//
// Read again from the records because the two do not always both arrive. A real history
// notification is processed inside `ev.buffer()`, and the buffer rebuilds
// `messaging-history.set` field by field out of what it accumulated -- chats, contacts,
// messages, and no derived list -- so on that path `lidPnMappings` is simply absent and
// the chat records are the only copy left. The derived list is still read where it does
// arrive: it carries a `userReceipt` fallback for a LID chat whose record has no `pnJid`,
// which nothing here could reconstruct.
export function chatLidPnPairs(
  chats: readonly {
    id?: string | null;
    pnJid?: string | null;
    lidJid?: string | null;
  }[],
): LIDMapping[] {
  const pairs: LIDMapping[] = [];
  for (const chat of chats) {
    const id = chat.id;
    if (!id) {
      continue;
    }

    if (lidUser(id)) {
      if (chat.pnJid) {
        pairs.push({ lid: id, pn: chat.pnJid });
      }
      // A chat keyed the other way names its own LID, and its messages can still be
      // LID-addressed. Gated on the id being a phone address so a group's jid can never
      // enter the index as one.
    } else if (
      chat.lidJid &&
      PHONE_SERVERS.includes(splitJid(id)?.server ?? "")
    ) {
      pairs.push({ lid: chat.lidJid, pn: id });
    }
  }
  return pairs;
}

// LID user to phone jid, merged from every source that holds part of it. The
// first source to name a LID wins, so pass the ones that describe this dump
// before the ones that merely remember it. Phone jids are normalized, because
// the mapping store answers with a device suffix (`:0`) that a live message
// never carries.
export function lidPnIndex(
  ...sources: (readonly LIDMapping[] | null | undefined)[]
): Map<string, string> {
  const index = new Map<string, string>();
  for (const source of sources) {
    for (const { lid, pn } of source ?? []) {
      const user = lidUser(lid);
      const phone = splitJid(pn);
      if (user && phone && !index.has(user)) {
        index.set(user, `${phone.user}@${phone.server}`);
      }
    }
  }
  return index;
}

// Puts back on a history key the addressing fields the live decoder stamps from
// stanza attributes, so an imported message is addressed exactly like the same
// message would have been live.
//
// `addressingMode` is stamped from the address alone and does not wait for the
// mapping: that a chat is LID-addressed is a fact about the message, and saying
// so is what stops a client from reading the LID as a phone number. The alt jid
// follows only when the mapping resolved -- a phone number we do not know must
// arrive absent, never guessed.
//
// Both rules are the decoder's, copied rather than reasoned about. The sender is the
// participant where there is one and the chat otherwise, which is a 1:1 peer, a group's
// author, or a broadcast's. Its alternate address is filed under `participantAlt` for a
// group and `remoteJidAlt` for everything else -- and it is the chat being a group that
// decides that, not which of the two fields the sender was read from.
export function restoreAddressing<T extends HistoryMessage>(
  messages: readonly T[],
  index: ReadonlyMap<string, string>,
): T[] {
  return messages.map((message) => {
    const key = message.key;
    const sender = lidUser(key?.participant) ?? lidUser(key?.remoteJid);
    if (!key || !sender) {
      return message;
    }

    const senderAlt = index.get(sender);
    const altField =
      splitJid(key.remoteJid)?.server === "g.us"
        ? "participantAlt"
        : "remoteJidAlt";
    return {
      ...message,
      key: {
        ...key,
        addressingMode: "lid",
        ...(senderAlt ? { [altField]: senderAlt } : {}),
      },
    };
  });
}

// What the client is told about a history dump. The contacts and participant
// lists Baileys ships alongside the messages are dropped: nothing reads them,
// and on a mature account they are a second dump the size of the first. The
// chats are dropped too, except for the one bit above.
export interface BaileysHistoryFramePayload {
  messages: proto.IWebMessageInfo[];
  // proto.HistorySync.HistorySyncType. Decides whether the dump is an offline
  // replay (RECENT) the client must always accept, or an archive it may only
  // store with consent.
  syncType?: number | null;
  progress?: number | null;
  isLatest?: boolean;
  // Position of this frame within one `messaging-history.set` event, counted
  // from zero. Order does not matter to the importer (it sorts by timestamp and
  // dedupes by id); this is here so a truncated sync is legible in the logs.
  // There is no total: the frames are produced lazily, so the count is not
  // known until the last one has been sent.
  chunkIndex: number;
  // Chats WhatsApp flagged as having nothing older left. Sent on the first
  // frame only: it describes the answer, not the slice of messages this frame
  // happens to carry.
  exhausted?: string[];
}
