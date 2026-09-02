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
export function messageTimestampSeconds(message: WAMessage): number {
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
  const secret =
    normalizeMessageContent(message.message)?.messageContextInfo
      ?.messageSecret ||
    message.message?.messageContextInfo?.messageSecret ||
    message.messageSecret;
  return secret?.length ? secret : null;
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
