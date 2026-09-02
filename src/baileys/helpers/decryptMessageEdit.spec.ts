import { describe, expect, it } from "bun:test";
import { createCipheriv, randomBytes } from "node:crypto";
import {
  decryptMessageEdit,
  type MessageEditSenders,
  messageEditKey,
} from "./decryptMessageEdit";

const ORIG_MSG_ID = "3EB078E05D8F792B76A79F";
const SENDERS: MessageEditSenders = {
  origMsgSender: "167392323834034@lid",
  editSender: "167392323834034@lid",
};

// Mirrors what WhatsApp does on the sending side, so a round trip exercises the
// real GCM framing (tag appended to the ciphertext) rather than a stand-in.
// It shares messageEditKey with the code under test on purpose: the derivation
// itself has no published test vector, and is proven against a real edit from a
// real phone, not here. What these tests own is the framing and the candidate
// search around it.
function seal(
  plaintext: Buffer,
  messageSecret: Uint8Array,
  senders: MessageEditSenders,
) {
  const encIv = randomBytes(12);
  const key = messageEditKey({
    ...senders,
    origMsgId: ORIG_MSG_ID,
    messageSecret,
  });
  const cipher = createCipheriv("aes-256-gcm", key, encIv);
  cipher.setAAD(Buffer.alloc(0));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { encIv, encPayload: Buffer.concat([body, cipher.getAuthTag()]) };
}

describe("messageEditKey", () => {
  const messageSecret = Buffer.alloc(32, 7);

  it("derives 32 bytes", () => {
    expect(
      messageEditKey({ ...SENDERS, origMsgId: ORIG_MSG_ID, messageSecret }),
    ).toHaveLength(32);
  });

  it("is deterministic for the same inputs", () => {
    const args = { ...SENDERS, origMsgId: ORIG_MSG_ID, messageSecret };
    expect(messageEditKey(args)).toEqual(messageEditKey(args));
  });

  // The two parties enter the derivation in a fixed order, so swapping them has
  // to change the key — otherwise a candidate pair that is merely reversed
  // would decrypt and we would trust the wrong attribution.
  it("binds the two parties in order", () => {
    const forward = messageEditKey({
      origMsgSender: "a@lid",
      editSender: "b@lid",
      origMsgId: ORIG_MSG_ID,
      messageSecret,
    });
    const reversed = messageEditKey({
      origMsgSender: "b@lid",
      editSender: "a@lid",
      origMsgId: ORIG_MSG_ID,
      messageSecret,
    });
    expect(forward).not.toEqual(reversed);
  });

  it("binds the original message id", () => {
    const args = { ...SENDERS, messageSecret };
    expect(messageEditKey({ ...args, origMsgId: "AAA" })).not.toEqual(
      messageEditKey({ ...args, origMsgId: "BBB" }),
    );
  });
});

describe("decryptMessageEdit", () => {
  const messageSecret = randomBytes(32);
  const plaintext = Buffer.from("the edited body", "utf8");

  it("recovers the plaintext for the matching candidate", () => {
    const { encPayload, encIv } = seal(plaintext, messageSecret, SENDERS);

    const result = decryptMessageEdit({
      encPayload,
      encIv,
      origMsgId: ORIG_MSG_ID,
      messageSecret,
      senderCandidates: [SENDERS],
    });

    expect(result?.plaintext).toEqual(plaintext);
    expect(result?.senders).toEqual(SENDERS);
  });

  // The whole reason candidates exist: a chat mid-LID-migration reports the
  // same person under two JIDs and only one of them went into the key.
  it("keeps trying until a candidate verifies, and reports which one", () => {
    const { encPayload, encIv } = seal(plaintext, messageSecret, SENDERS);
    const wrong: MessageEditSenders = {
      origMsgSender: "553499503261@s.whatsapp.net",
      editSender: "553499503261@s.whatsapp.net",
    };

    const result = decryptMessageEdit({
      encPayload,
      encIv,
      origMsgId: ORIG_MSG_ID,
      messageSecret,
      senderCandidates: [wrong, SENDERS],
    });

    expect(result?.plaintext).toEqual(plaintext);
    expect(result?.senders).toEqual(SENDERS);
  });

  // A wrong guess must be a clean miss. The tag check is what makes brute
  // forcing the JID form safe: it can never yield a wrong plaintext.
  it("returns null when no candidate verifies", () => {
    const { encPayload, encIv } = seal(plaintext, messageSecret, SENDERS);

    expect(
      decryptMessageEdit({
        encPayload,
        encIv,
        origMsgId: ORIG_MSG_ID,
        messageSecret,
        senderCandidates: [
          { origMsgSender: "x@lid", editSender: "y@lid" },
          { origMsgSender: "y@lid", editSender: "x@lid" },
        ],
      }),
    ).toBeNull();
  });

  it("returns null when the wrong message secret is stored", () => {
    const { encPayload, encIv } = seal(plaintext, messageSecret, SENDERS);

    expect(
      decryptMessageEdit({
        encPayload,
        encIv,
        origMsgId: ORIG_MSG_ID,
        messageSecret: randomBytes(32),
        senderCandidates: [SENDERS],
      }),
    ).toBeNull();
  });

  it("returns null with no candidates at all", () => {
    const { encPayload, encIv } = seal(plaintext, messageSecret, SENDERS);

    expect(
      decryptMessageEdit({
        encPayload,
        encIv,
        origMsgId: ORIG_MSG_ID,
        messageSecret,
        senderCandidates: [],
      }),
    ).toBeNull();
  });

  // A payload too short to hold a tag would make the subarray split produce
  // nonsense; refuse it instead of letting createDecipheriv decide.
  it("refuses a payload shorter than the GCM tag", () => {
    expect(
      decryptMessageEdit({
        encPayload: Buffer.alloc(16),
        encIv: randomBytes(12),
        origMsgId: ORIG_MSG_ID,
        messageSecret,
        senderCandidates: [SENDERS],
      }),
    ).toBeNull();
  });
});
