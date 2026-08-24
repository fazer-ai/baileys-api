import type { proto } from "@whiskeysockets/baileys";

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

// What the client is told about a history dump. The chats, contacts and
// participant lists Baileys ships alongside the messages are dropped: nothing
// reads them, and on a mature account they are a second dump the size of the
// first.
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
}
