import { describe, expect, it } from "bun:test";
import { proto as realProto } from "@whiskeysockets/baileys/WAProto/index.js";
import {
  decodeEditedMessage,
  orderEditsOldestFirst,
  ownMessageSecret,
  replaceInnerContent,
  secretMessageEdit,
} from "./secretEncryptedMessageEdit";

const TARGET_KEY = {
  remoteJid: "89572297961476@lid",
  fromMe: true,
  id: "3EB078E05D8F792B76A79F",
};

function upsert(message: any) {
  return {
    key: { remoteJid: "167392323834034@lid", fromMe: false, id: "edit-1" },
    message,
  } as any;
}

function encoded(message: any) {
  return realProto.Message.encode(
    realProto.Message.fromObject(message),
  ).finish();
}

describe("secretMessageEdit", () => {
  const encrypted = {
    targetMessageKey: TARGET_KEY,
    encPayload: new Uint8Array([1, 2, 3]),
    encIv: new Uint8Array([4, 5, 6]),
  };

  it("recognizes the numeric enum", () => {
    expect(
      secretMessageEdit(
        upsert({ secretEncryptedMessage: { ...encrypted, secretEncType: 2 } }),
      ),
    ).toEqual({
      targetKey: TARGET_KEY,
      encPayload: encrypted.encPayload,
      encIv: encrypted.encIv,
    });
  });

  // Which of the two a payload carries depends on how it was decoded upstream,
  // and betting on one is how this kind of check silently stops matching.
  it("recognizes the symbolic enum", () => {
    expect(
      secretMessageEdit(
        upsert({
          secretEncryptedMessage: {
            ...encrypted,
            secretEncType: "MESSAGE_EDIT",
          },
        }),
      ),
    ).not.toBeNull();
  });

  it("looks through a disappearing-message wrapper", () => {
    expect(
      secretMessageEdit(
        upsert({
          ephemeralMessage: {
            message: {
              secretEncryptedMessage: { ...encrypted, secretEncType: 2 },
            },
          },
        }),
      ),
    ).not.toBeNull();
  });

  // EVENT_EDIT (1) rides the same node and is a different use case with a
  // different key derivation; decrypting it as a message edit would fail the
  // tag check anyway, but claiming it here would swallow the event.
  it("ignores a secret message that is not a message edit", () => {
    expect(
      secretMessageEdit(
        upsert({ secretEncryptedMessage: { ...encrypted, secretEncType: 1 } }),
      ),
    ).toBeNull();
  });

  it("ignores an ordinary message", () => {
    expect(secretMessageEdit(upsert({ conversation: "oi" }))).toBeNull();
  });

  it("ignores an edit with no target to apply it to", () => {
    expect(
      secretMessageEdit(
        upsert({
          secretEncryptedMessage: {
            ...encrypted,
            targetMessageKey: { remoteJid: "x@lid", fromMe: true },
            secretEncType: 2,
          },
        }),
      ),
    ).toBeNull();
  });

  it("ignores an edit with nothing encrypted in it", () => {
    expect(
      secretMessageEdit(
        upsert({
          secretEncryptedMessage: {
            targetMessageKey: TARGET_KEY,
            secretEncType: 2,
          },
        }),
      ),
    ).toBeNull();
  });
});

describe("ownMessageSecret", () => {
  it("returns the secret a message publishes", () => {
    const secret = new Uint8Array(32).fill(9);

    expect(
      ownMessageSecret(
        upsert({
          conversation: "oi",
          messageContextInfo: { messageSecret: secret },
        }),
      ),
    ).toEqual(secret);
  });

  // A wrapper keeps its context outside itself, so normalizing walks straight
  // past the secret and every edit to a disappearing message stops decrypting.
  it("reads the outer context of a wrapped message", () => {
    const secret = new Uint8Array(32).fill(9);

    expect(
      ownMessageSecret(
        upsert({
          messageContextInfo: { messageSecret: secret },
          ephemeralMessage: { message: { conversation: "oi" } },
        }),
      ),
    ).toEqual(secret);
  });

  // A history dump puts it on the WebMessageInfo instead of in the content.
  it("reads the secret a history dump carries on the message itself", () => {
    const secret = new Uint8Array(32).fill(9);
    const message = upsert({ conversation: "oi" });
    message.messageSecret = secret;

    expect(ownMessageSecret(message)).toEqual(secret);
  });

  it("returns null when there is none", () => {
    expect(ownMessageSecret(upsert({ conversation: "oi" }))).toBeNull();
  });

  // A wrapper's own context can exist for an expiration or a device list and
  // carry no secret at all. Protobuf gives that field an empty Uint8Array,
  // which is truthy, so the candidate has to be chosen by length.
  it("skips an empty inner secret and takes the outer one", () => {
    const secret = new Uint8Array(32).fill(9);

    expect(
      ownMessageSecret(
        upsert({
          messageContextInfo: { messageSecret: secret },
          ephemeralMessage: {
            message: {
              conversation: "oi",
              messageContextInfo: { messageSecret: new Uint8Array(0) },
            },
          },
        }),
      ),
    ).toEqual(secret);
  });

  // The same hole one level further in: a dump strips the content's secret and
  // carries it on the WebMessageInfo.
  it("skips an empty content secret and takes the dump's", () => {
    const secret = new Uint8Array(32).fill(9);
    const message = upsert({
      conversation: "oi",
      messageContextInfo: { messageSecret: new Uint8Array(0) },
    });
    message.messageSecret = secret;

    expect(ownMessageSecret(message)).toEqual(secret);
  });

  it("treats an empty secret as none", () => {
    expect(
      ownMessageSecret(
        upsert({
          conversation: "oi",
          messageContextInfo: { messageSecret: new Uint8Array(0) },
        }),
      ),
    ).toBeNull();
  });
});

describe("decodeEditedMessage", () => {
  it("decodes a bare replacement body", () => {
    const decoded = decodeEditedMessage(
      encoded({ conversation: "oi editado" }),
    );

    expect(decoded.conversation).toBe("oi editado");
  });

  it("unwraps a replacement wrapped as an editedMessage", () => {
    const decoded = decodeEditedMessage(
      encoded({ editedMessage: { message: { conversation: "oi editado" } } }),
    );

    expect(decoded.conversation).toBe("oi editado");
  });

  it("unwraps a replacement wrapped in a protocolMessage", () => {
    const decoded = decodeEditedMessage(
      encoded({
        protocolMessage: {
          type: realProto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
          editedMessage: { conversation: "oi editado" },
        },
      }),
    );

    expect(decoded.conversation).toBe("oi editado");
  });
});

describe("replaceInnerContent", () => {
  it("replaces the content of a bare message", () => {
    expect(
      replaceInnerContent({ conversation: "oi" }, { conversation: "editado" }),
    ).toEqual({ conversation: "editado" });
  });

  // The wrapper is what tells the consumer the message disappears, and the
  // context next to it is where the secret for the NEXT edit lives.
  it("keeps the wrapper and the outer context", () => {
    const secret = new Uint8Array(32).fill(9);

    expect(
      replaceInnerContent(
        {
          messageContextInfo: { messageSecret: secret },
          ephemeralMessage: { message: { conversation: "oi" } },
        },
        { conversation: "editado" },
      ),
    ).toEqual({
      messageContextInfo: { messageSecret: secret },
      ephemeralMessage: { message: { conversation: "editado" } },
    });
  });

  it("replaces at the bottom of a nested wrapper", () => {
    expect(
      replaceInnerContent(
        {
          ephemeralMessage: {
            message: { viewOnceMessageV2: { message: { conversation: "oi" } } },
          },
        },
        { conversation: "editado" },
      ),
    ).toEqual({
      ephemeralMessage: {
        message: {
          viewOnceMessageV2: { message: { conversation: "editado" } },
        },
      },
    });
  });

  it("fills a wrapper that carries no content", () => {
    expect(
      replaceInnerContent(
        { ephemeralMessage: {} },
        { conversation: "editado" },
      ),
    ).toEqual({ ephemeralMessage: { message: { conversation: "editado" } } });
  });

  it("returns the replacement when there is nothing to keep", () => {
    expect(replaceInnerContent(null, { conversation: "editado" })).toEqual({
      conversation: "editado",
    });
  });
});

describe("orderEditsOldestFirst", () => {
  const at = (seconds: number, label: string) => ({
    label,
    message: { messageTimestamp: seconds } as any,
  });

  it("sorts by the time the edit was made", () => {
    expect(
      orderEditsOldestFirst([at(30, "b"), at(10, "a"), at(50, "c")]).map(
        (e) => e.label,
      ),
    ).toEqual(["a", "b", "c"]);
  });

  it("keeps arrival order for edits stamped in the same second", () => {
    expect(
      orderEditsOldestFirst([at(10, "a"), at(10, "b")]).map((e) => e.label),
    ).toEqual(["a", "b"]);
  });

  // A history array is built newest-first, so equal stamps there mean the
  // opposite of what they mean live.
  it("reverses ties when the array was built newest-first", () => {
    expect(
      orderEditsOldestFirst([at(10, "b"), at(10, "a")], {
        newestFirst: true,
      }).map((e) => e.label),
    ).toEqual(["a", "b"]);
  });

  it("reads a Long timestamp", () => {
    expect(
      orderEditsOldestFirst([
        { label: "b", message: { messageTimestamp: { low: 30, high: 0 } } },
        { label: "a", message: { messageTimestamp: { low: 10, high: 0 } } },
      ] as any).map((e: any) => e.label),
    ).toEqual(["a", "b"]);
  });
});
