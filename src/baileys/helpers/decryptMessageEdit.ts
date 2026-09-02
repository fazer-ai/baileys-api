import { createDecipheriv, hkdfSync } from "node:crypto";

// AES-GCM appends its authentication tag to the ciphertext.
const GCM_TAG_LENGTH = 16;

// Part of the key derivation input, so this string is protocol rather than a
// label: it is the `MsgSecretType` WhatsApp uses for a message edit. See
// whatsmeow's msgsecret.go (`EncSecretMessageEdit`) and, on the Baileys side,
// the identical construction in Utils/reporting-utils.js.
const MESSAGE_EDIT_USE_CASE = "Message Edit";

export interface MessageEditSenders {
  /** JID of whoever wrote the message being edited. */
  origMsgSender: string;
  /** JID of whoever sent the edit. */
  editSender: string;
}

/**
 * HKDF-SHA256 over the original message's secret, bound to the message id and
 * to both parties, exactly as WhatsApp derives it. A wrong JID string yields a
 * wrong key and the GCM tag check fails — which is why callers try candidates.
 */
export function messageEditKey({
  origMsgId,
  origMsgSender,
  editSender,
  messageSecret,
}: MessageEditSenders & {
  origMsgId: string;
  messageSecret: Uint8Array;
}): Buffer {
  const info = Buffer.concat([
    Buffer.from(origMsgId, "utf8"),
    Buffer.from(origMsgSender, "utf8"),
    Buffer.from(editSender, "utf8"),
    Buffer.from(MESSAGE_EDIT_USE_CASE, "utf8"),
  ]);

  // Salt omitted, matching whatsmeow's hkdfutil.SHA256(secret, nil, info, 32).
  return Buffer.from(
    hkdfSync("sha256", messageSecret, Buffer.alloc(0), info, 32),
  );
}

/**
 * Decrypts a `secretEncryptedMessage` of type MESSAGE_EDIT into the serialized
 * `proto.Message` the author replaced the original with.
 *
 * `senderCandidates` is tried in order and the first pair whose GCM tag
 * verifies wins. Candidates exist because WhatsApp is mid-migration from phone
 * JIDs to LIDs and the derivation is over the JID *string*: which of the two
 * forms went into the key is not something the payload tells us. The tag check
 * makes a wrong guess a clean miss, never a wrong plaintext.
 *
 * Returns the plaintext and the pair that produced it, or null when no
 * candidate verifies.
 */
export function decryptMessageEdit({
  encPayload,
  encIv,
  origMsgId,
  messageSecret,
  senderCandidates,
}: {
  encPayload: Uint8Array;
  encIv: Uint8Array;
  origMsgId: string;
  messageSecret: Uint8Array;
  senderCandidates: MessageEditSenders[];
}): { plaintext: Buffer; senders: MessageEditSenders } | null {
  if (encPayload.length <= GCM_TAG_LENGTH) {
    return null;
  }

  const ciphertext = encPayload.subarray(0, encPayload.length - GCM_TAG_LENGTH);
  const tag = encPayload.subarray(encPayload.length - GCM_TAG_LENGTH);

  for (const senders of senderCandidates) {
    const key = messageEditKey({ ...senders, origMsgId, messageSecret });
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, encIv);
      // No additional data for a message edit: WhatsApp only binds AAD on the
      // poll-vote and event-response use cases.
      decipher.setAAD(Buffer.alloc(0));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return { plaintext, senders };
    } catch {
      // Wrong candidate: the tag did not verify. Try the next one.
    }
  }

  return null;
}
