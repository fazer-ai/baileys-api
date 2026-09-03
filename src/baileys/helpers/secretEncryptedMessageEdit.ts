import {
  normalizeMessageContent,
  proto,
  type WAMessage,
  type WAMessageKey,
} from "@whiskeysockets/baileys";

// Enum values reach us as the number or, depending on how the payload was
// decoded, as the symbolic name. Accept both rather than betting on one.
const MESSAGE_EDIT_ENC_TYPES: ReadonlySet<number | string> = new Set([
  proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT,
  "MESSAGE_EDIT",
]);

/**
 * The unix seconds on a message. A protobuf 64-bit field decodes either as a
 * number or as a `{ low, high }` Long depending on how it came off the wire,
 * and a dump mixes both.
 */
export function messageTimestampSeconds(
  message: Pick<WAMessage, "messageTimestamp">,
): number {
  const timestamp = message.messageTimestamp;
  if (typeof timestamp === "number") {
    return timestamp;
  }
  if (timestamp && typeof timestamp === "object") {
    const { low = 0, high = 0 } = timestamp as { low?: number; high?: number };
    return high * 2 ** 32 + (low >>> 0);
  }
  return 0;
}

export interface SecretMessageEdit {
  targetKey: WAMessageKey;
  encPayload: Uint8Array;
  encIv: Uint8Array;
}

/**
 * The encrypted edit carried by a message, if that is what it is.
 *
 * WhatsApp used to deliver an edit as a plaintext `protocolMessage` of type
 * MESSAGE_EDIT, which Baileys turns into a `messages.update`. Newer clients
 * send `secretEncryptedMessage` instead — encrypted under the ORIGINAL
 * message's secret — and Baileys has no handler for it, so the raw blob
 * surfaces as an ordinary incoming message and every consumer renders it as
 * unsupported content.
 */
export function secretMessageEdit(
  message: WAMessage,
): SecretMessageEdit | null {
  const content = normalizeMessageContent(message.message);
  const encrypted = content?.secretEncryptedMessage;
  if (!encrypted?.encPayload || !encrypted.encIv) {
    return null;
  }

  const encType = encrypted.secretEncType;
  if (encType == null || !MESSAGE_EDIT_ENC_TYPES.has(encType)) {
    return null;
  }

  const targetKey = encrypted.targetMessageKey;
  if (!targetKey?.id) {
    return null;
  }

  return {
    targetKey: targetKey as WAMessageKey,
    encPayload: encrypted.encPayload,
    encIv: encrypted.encIv,
  };
}

/**
 * The message secret a message publishes for its own future modifications
 * (edits, reactions, poll votes). Only present on messages that can be
 * modified, which is why the caller stores it opportunistically.
 *
 * Three homes, one per route a message can arrive by:
 *
 *  - the normalized content, for an ordinary live message;
 *  - the outer `Message`, because a wrapper keeps its context outside itself —
 *    an ephemeral message's `messageContextInfo` sits next to the wrapper, not
 *    inside it, and normalizing walks straight past it;
 *  - the `WebMessageInfo` itself, which is where a history dump puts it.
 *
 * A secret read from any of them decrypts the same edits; missing one just
 * means the edits to those messages arrive undecryptable.
 */
export function ownMessageSecret(message: WAMessage): Uint8Array | null {
  // Picked by length rather than by truthiness: an empty Uint8Array is truthy,
  // and protobuf hands one back for a bytes field that was never on the wire.
  // A `||` chain therefore stops at a messageContextInfo that exists for some
  // other reason — an expiration, a device list — and never reaches the secret
  // sitting one level out, which is the shape a wrapped message has.
  const candidates = [
    normalizeMessageContent(message.message)?.messageContextInfo?.messageSecret,
    message.message?.messageContextInfo?.messageSecret,
    message.messageSecret,
  ];
  return candidates.find((secret) => secret?.length) ?? null;
}

/**
 * The replacement content, as an `IMessage`, from a decrypted edit payload.
 *
 * The plaintext is a serialized `Message`. It has been observed both bare and
 * wrapped the way the plaintext edit path wraps it, so unwrap to the content
 * itself and let the caller re-wrap once, in one shape.
 */
export function decodeEditedMessage(plaintext: Uint8Array): proto.IMessage {
  const decoded = proto.Message.decode(plaintext);
  return (
    decoded.editedMessage?.message ??
    decoded.protocolMessage?.editedMessage ??
    decoded
  );
}

// The same chain `normalizeMessageContent` walks, in the same order. Kept as a
// local list rather than reused from Baileys because Baileys only exposes the
// walk, not the path it took, and the path is what has to be rebuilt.
const WRAPPER_KEYS = [
  "ephemeralMessage",
  "viewOnceMessage",
  "documentWithCaptionMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "editedMessage",
  "associatedChildMessage",
  "groupStatusMessage",
  "groupStatusMessageV2",
] as const;

/**
 * Puts `replacement` where the message's real content sits, keeping whatever
 * wrapped it.
 *
 * A disappearing message arrives as `ephemeralMessage: { message: ... }`, and
 * its `messageContextInfo` sits on the OUTER object, next to the wrapper.
 * Assigning the decoded edit over the whole `message` would drop both: the
 * consumer would receive what looks like an ordinary, non-disappearing message,
 * and the secret the next edit needs would go with it.
 *
 * An unwrapped message has no outer anything, so there the replacement simply
 * is the new content.
 */
export function replaceInnerContent(
  outer: proto.IMessage | null | undefined,
  replacement: proto.IMessage,
): proto.IMessage {
  if (!outer) {
    return replacement;
  }

  let deepest: { message?: proto.IMessage | null } | null = null;
  let content: proto.IMessage = outer;

  // Bounded like Baileys' own walk, so a payload that wraps itself cannot spin.
  for (let depth = 0; depth < 5; depth += 1) {
    const key = WRAPPER_KEYS.find(
      (candidate) => (content as Record<string, unknown>)[candidate],
    );
    if (!key) {
      break;
    }
    deepest = content[key] as { message?: proto.IMessage | null };
    content = deepest.message ?? {};
  }

  if (!deepest) {
    return replacement;
  }

  deepest.message = replacement;
  return outer;
}

/**
 * The edits in the order they were made, oldest first.
 *
 * Two edits of one message are last-one-wins, so applying them in the wrong
 * order leaves the older text standing. A history dump makes that the DEFAULT
 * rather than an edge case: Baileys builds each chat's array newest-first (it
 * keeps `msgs[0]` as "the most recent message in the chat"), so walking it
 * straight applies the newest replacement and then overwrites it with an older
 * one. The same reversal then rides into the unresolved queue, which emits in
 * the order it was given.
 *
 * `newestFirst` is the tie-break, not the sort: messages stamped in the same
 * second carry no ordering of their own, so the only thing left to go on is
 * which way the array they came in was built.
 */
export function orderEditsOldestFirst<T extends { message: WAMessage }>(
  edits: T[],
  { newestFirst = false }: { newestFirst?: boolean } = {},
): T[] {
  const indexed = edits.map((entry, index) => ({ entry, index }));
  indexed.sort((a, b) => {
    const byTime =
      messageTimestampSeconds(a.entry.message) -
      messageTimestampSeconds(b.entry.message);
    if (byTime !== 0) {
      return byTime;
    }
    return newestFirst ? b.index - a.index : a.index - b.index;
  });
  return indexed.map(({ entry }) => entry);
}
