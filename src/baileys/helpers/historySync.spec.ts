import { describe, expect, it } from "bun:test";
import type { WAMessageKey } from "@whiskeysockets/baileys";
import {
  chatLidPnPairs,
  exhaustedChats,
  groupNames,
  historyFrames,
  lidPnIndex,
  NO_MORE_HISTORY,
  restoreAddressing,
  stripHistoryPayload,
  unresolvedLids,
} from "./historySync";

function textMessage(id: string, text: string) {
  return {
    key: { id, remoteJid: "5511999@s.whatsapp.net", fromMe: false },
    messageTimestamp: 1_700_000_000,
    message: { conversation: text },
  };
}

function imageMessage(id: string, thumbnailBytes: number) {
  return {
    key: { id, remoteJid: "5511999@s.whatsapp.net", fromMe: false },
    messageTimestamp: 1_700_000_000,
    message: {
      imageMessage: {
        caption: "hi",
        mimetype: "image/jpeg",
        url: "https://mmg.whatsapp.net/d/f/abc.enc",
        directPath: "/v/t62.7118-24/abc.enc",
        mediaKey: new Uint8Array(32).fill(7),
        fileSha256: new Uint8Array(32).fill(8),
        jpegThumbnail: new Uint8Array(thumbnailBytes).fill(255),
      },
    },
  };
}

describe("stripHistoryPayload", () => {
  it("drops the thumbnail while keeping everything the client reads", () => {
    const stripped = stripHistoryPayload(imageMessage("A", 4_096));
    const image = stripped.message.imageMessage as Record<string, unknown>;

    expect(image.jpegThumbnail).toBeUndefined();
    expect(image.mediaKey).toBeUndefined();
    expect(image.fileSha256).toBeUndefined();
    expect(image.caption).toBe("hi");
    expect(image.mimetype).toBe("image/jpeg");
    // Read back for locations and ad attribution, so it must survive.
    expect(image.url).toBe("https://mmg.whatsapp.net/d/f/abc.enc");
    expect(stripped.key.id).toBe("A");
  });

  it("strips nested quotes, where a second thumbnail hides", () => {
    const stripped = stripHistoryPayload({
      message: {
        extendedTextMessage: {
          text: "replying",
          contextInfo: {
            stanzaId: "ORIGINAL",
            quotedMessage: {
              imageMessage: { jpegThumbnail: new Uint8Array(2_048).fill(1) },
            },
          },
        },
      },
    });

    const context = stripped.message.extendedTextMessage.contextInfo as Record<
      string,
      unknown
    >;
    expect(context.stanzaId).toBe("ORIGINAL");
    expect(
      (context.quotedMessage as { imageMessage: Record<string, unknown> })
        .imageMessage.jpegThumbnail,
    ).toBeUndefined();
  });

  it("shrinks a serialized image message by an order of magnitude", () => {
    const message = imageMessage("A", 8_192);
    const before = JSON.stringify(message).length;
    const after = JSON.stringify(stripHistoryPayload(message)).length;

    expect(after).toBeLessThan(before / 10);
  });

  it("leaves values that are not objects alone", () => {
    expect(stripHistoryPayload(null)).toBeNull();
    expect(stripHistoryPayload(7)).toBe(7);
    expect(stripHistoryPayload("jpegThumbnail")).toBe("jpegThumbnail");
  });
});

describe("historyFrames", () => {
  it("yields nothing for an empty dump", () => {
    expect([...historyFrames([], 1_024)]).toEqual([]);
  });

  it("keeps a small dump in one frame", () => {
    const messages = [textMessage("A", "one"), textMessage("B", "two")];
    const frames = [...historyFrames(messages, 512 * 1024)];

    expect(frames).toHaveLength(1);
    expect(frames[0].messages).toHaveLength(2);
  });

  it("splits so no frame exceeds the budget, and loses no message", () => {
    const maxBytes = 4_096;
    const messages = Array.from({ length: 200 }, (_, i) =>
      textMessage(`ID-${i}`, "x".repeat(100)),
    );

    const frames = [...historyFrames(messages, maxBytes)];

    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) {
      expect(Buffer.byteLength(JSON.stringify(frame), "utf8")).toBeLessThan(
        maxBytes + 1_024,
      );
    }

    const ids = frames
      .flatMap((frame) => frame.messages)
      .map((message) => message.key.id);
    expect(ids).toEqual(messages.map((message) => message.key.id));
  });

  it("sends a message larger than the budget on its own", () => {
    const messages = [
      textMessage("SMALL", "x"),
      textMessage("HUGE", "y".repeat(10_000)),
      textMessage("SMALL-2", "z"),
    ];

    const frames = [...historyFrames(messages, 1_024)];

    expect(frames.map((frame) => frame.messages.map((m) => m.key.id))).toEqual([
      ["SMALL"],
      ["HUGE"],
      ["SMALL-2"],
    ]);
  });

  it("sizes frames after stripping, not before", () => {
    // Each message is ~40 KB of JSON with the thumbnail and a few hundred bytes
    // without it, so the budget only fits them all if the strip already ran.
    const messages = Array.from({ length: 10 }, (_, i) =>
      imageMessage(`ID-${i}`, 8_192),
    );

    const frames = [...historyFrames(messages, 8_192)];

    expect(frames).toHaveLength(1);
    expect(frames[0].messages).toHaveLength(10);
  });
});

describe("restoring the addressing a dump strips", () => {
  const LID = "235085806727321@lid";
  const PN = "5511999999999@s.whatsapp.net";

  function chatMessage(remoteJid: string, participant?: string) {
    const key: WAMessageKey = {
      id: "A",
      remoteJid,
      participant,
      fromMe: false,
    };
    return { key, message: { conversation: "hi" } };
  }

  describe("which addresses are left to resolve", () => {
    it("names the chats and the group authors addressed by LID, once each", () => {
      expect(
        unresolvedLids(
          [
            chatMessage(LID),
            chatMessage(LID),
            chatMessage("120363@g.us", "777@lid"),
            chatMessage(PN),
            chatMessage("120363@g.us", PN),
          ],
          new Map(),
        ),
      ).toEqual([LID, "777@lid"]);
    });

    // What the event already said is not worth a read, and on a bootstrap dump
    // the event says it about every chat in it.
    it("leaves out the LIDs the index already resolves", () => {
      expect(
        unresolvedLids(
          [chatMessage(LID), chatMessage("777@lid")],
          lidPnIndex([{ lid: LID, pn: PN }]),
        ),
      ).toEqual(["777@lid"]);
    });

    // The index is keyed by the LID user, the dump addresses by full jid: a
    // device suffix must not read as a LID nobody has resolved.
    it("matches an address that carries a device suffix", () => {
      expect(
        unresolvedLids(
          [chatMessage("235085806727321:3@lid")],
          lidPnIndex([{ lid: LID, pn: PN }]),
        ),
      ).toEqual([]);
    });

    it("names nothing for a dump with no LID in it", () => {
      expect(
        unresolvedLids([chatMessage(PN), { key: null }], new Map()),
      ).toEqual([]);
    });
  });

  // A business-hosted account is addressed on `hosted.lid`, which `jidDecode` reads as a
  // LID domain and upstream's `isLidUser` -- a plain `@lid` suffix test -- does not. Left
  // out, its chats kept the exact shape this whole change exists to fix.
  describe("the hosted form of a LID", () => {
    const HOSTED = "235085806727321@hosted.lid";

    it("marks a hosted chat LID-addressed like any other", () => {
      const [message] = restoreAddressing([chatMessage(HOSTED)], new Map());

      expect(message.key.addressingMode).toBe("lid");
    });

    it("takes a hosted mapping out of the event like any other", () => {
      const [message] = restoreAddressing(
        [chatMessage(HOSTED)],
        lidPnIndex([{ lid: HOSTED, pn: "5511999999999@hosted" }]),
      );

      expect(message.key.remoteJidAlt).toBe("5511999999999@hosted");
    });
  });

  // The derived list is dropped by the event buffer, which is the path a real history
  // notification takes, so the chat records are the only copy that always arrives.
  describe("the pairs the chat records carry", () => {
    it("pairs a LID-addressed chat with the phone jid on its record", () => {
      expect(chatLidPnPairs([{ id: LID, pnJid: PN }])).toEqual([
        { lid: LID, pn: PN },
      ]);
    });

    it("pairs a phone-addressed chat with the LID on its record", () => {
      expect(chatLidPnPairs([{ id: PN, lidJid: LID }])).toEqual([
        { lid: LID, pn: PN },
      ]);
    });

    it("says nothing about a chat whose record names only itself", () => {
      expect(chatLidPnPairs([{ id: LID }, { id: PN }, {}])).toEqual([]);
    });

    // A group jid is neither address, and letting one in would file it as somebody's
    // phone number -- the very thing this change exists to prevent.
    it("never reads a group jid as a phone number", () => {
      expect(chatLidPnPairs([{ id: "120363@g.us", lidJid: LID }])).toEqual([]);
    });

    it("carries a hosted chat, whose record is where the store first learns the pair", () => {
      expect(
        chatLidPnPairs([{ id: "777@hosted.lid", pnJid: "5511@hosted" }]),
      ).toEqual([{ lid: "777@hosted.lid", pn: "5511@hosted" }]);
    });
  });

  describe("the mapping index", () => {
    it("keys by the LID user, so a device suffix still resolves", () => {
      const index = lidPnIndex([{ lid: "235085806727321:3@lid", pn: PN }]);

      expect(index.get("235085806727321")).toBe(PN);
    });

    // The store answers `<user>:0@s.whatsapp.net`; a live message never carries
    // the device, so neither may the alt jid we stamp from it.
    it("drops the device the mapping store adds to its answer", () => {
      const index = lidPnIndex([
        { lid: LID, pn: "5511999999999:0@s.whatsapp.net" },
      ]);

      expect(index.get("235085806727321")).toBe(PN);
    });

    // A source that hands the pair over the other way round would otherwise index the LID
    // as if it were the phone number, which is the exact shape this module exists to stop.
    it("drops a pair whose phone side is not a phone address", () => {
      const index = lidPnIndex([{ lid: LID, pn: "777888999@lid" }]);

      expect(index.size).toBe(0);
    });

    it("drops a pair handed over reversed", () => {
      const index = lidPnIndex([{ lid: PN, pn: LID }]);

      expect(index.size).toBe(0);
    });

    it("lets the earlier source win, which is the one describing this dump", () => {
      const index = lidPnIndex(
        [{ lid: LID, pn: PN }],
        [{ lid: LID, pn: "5511000000000@s.whatsapp.net" }],
      );

      expect(index.get("235085806727321")).toBe(PN);
    });

    it("survives a source that is absent or empty", () => {
      expect(lidPnIndex(undefined, null, []).size).toBe(0);
    });
  });

  it("gives a LID-addressed chat the phone number as its alt jid", () => {
    const [message] = restoreAddressing(
      [chatMessage(LID)],
      lidPnIndex([{ lid: LID, pn: PN }]),
    );

    expect(message.key.addressingMode).toBe("lid");
    expect(message.key.remoteJidAlt).toBe(PN);
    expect(message.key.remoteJid).toBe(LID);
  });

  // The half that fixes the report on its own: a client reading the address as
  // a phone number stops as soon as it is told the address is a LID, whether or
  // not the number behind it was ever resolved.
  it("marks the chat LID-addressed even with no mapping to resolve", () => {
    const [message] = restoreAddressing([chatMessage(LID)], new Map());

    expect(message.key.addressingMode).toBe("lid");
    expect(message.key.remoteJidAlt).toBeUndefined();
  });

  it("resolves a group author into participantAlt, leaving the group jid alone", () => {
    const [message] = restoreAddressing(
      [chatMessage("120363@g.us", "777@lid")],
      lidPnIndex([{ lid: "777@lid", pn: PN }]),
    );

    expect(message.key.remoteJid).toBe("120363@g.us");
    expect(message.key.remoteJidAlt).toBeUndefined();
    expect(message.key.participantAlt).toBe(PN);
    expect(message.key.addressingMode).toBe("lid");
  });

  // Not a group, so the decoder files the sender's alternate under `remoteJidAlt` even
  // though the sender was read off `participant`. The chat decides the field, not where
  // the address came from.
  it("files a broadcast sender the way a non-group key does", () => {
    const [message] = restoreAddressing(
      [chatMessage("status@broadcast", "777@lid")],
      lidPnIndex([{ lid: "777@lid", pn: PN }]),
    );

    expect(message.key.remoteJidAlt).toBe(PN);
    expect(message.key.participantAlt).toBeUndefined();
    expect(message.key.addressingMode).toBe("lid");
  });

  it("leaves a phone-addressed message exactly as it arrived", () => {
    const message = chatMessage(PN);
    const [restored] = restoreAddressing(
      [message],
      lidPnIndex([{ lid: LID, pn: PN }]),
    );

    expect(restored).toBe(message);
  });

  it("keeps everything else on the message and the key", () => {
    const [message] = restoreAddressing(
      [chatMessage(LID)],
      lidPnIndex([{ lid: LID, pn: PN }]),
    );

    expect(message.key.id).toBe("A");
    expect(message.key.fromMe).toBe(false);
    expect(message.message).toEqual({ conversation: "hi" });
  });
});

describe("which chats WhatsApp says are finished", () => {
  it("names the chats flagged as having nothing older", () => {
    expect(
      exhaustedChats([
        { id: "a@lid", endOfHistoryTransferType: NO_MORE_HISTORY },
        { id: "b@lid", endOfHistoryTransferType: 0 },
        { id: "c@lid" },
      ]),
    ).toEqual(["a@lid"]);
  });

  // The value it never sends on a bootstrap dump, and the one a proto default
  // reads as when the field was simply absent.
  it("does not read the enum default as an answer", () => {
    expect(
      exhaustedChats([{ id: "a@lid", endOfHistoryTransferType: 0 }]),
    ).toEqual([]);
  });

  it("ignores a flagged chat with no id to name it by", () => {
    expect(
      exhaustedChats([{ endOfHistoryTransferType: NO_MORE_HISTORY }]),
    ).toEqual([]);
  });
});

describe("what the groups in a dump are called", () => {
  it("names every group the chat records carry a subject for", () => {
    expect(
      groupNames([
        { id: "120363418525571303@g.us", name: "Guichê Web + fazer.ai" },
        { id: "120363422502290697@g.us", name: "Obra da casa" },
      ]),
    ).toEqual({
      "120363418525571303@g.us": "Guichê Web + fazer.ai",
      "120363422502290697@g.us": "Obra da casa",
    });
  });

  // A 1:1 record also carries a `name`, and there it is the peer's push name. The
  // messages already carry that per message, and the client applies its own rules about
  // when a push name may overwrite a stored contact -- so taking it from here would put a
  // second, ruleless writer on the same field.
  it("leaves the name on a one-to-one record alone", () => {
    expect(
      groupNames([
        { id: "5511999@s.whatsapp.net", name: "June" },
        { id: "5511888@lid", name: "July" },
      ]),
    ).toEqual({});
  });

  it("skips a group the dump names with nothing", () => {
    expect(
      groupNames([
        { id: "120363418525571303@g.us", name: "   " },
        { id: "120363422502290697@g.us", name: null },
        { id: "120363424043869415@g.us" },
        { name: "sem jid" },
      ]),
    ).toEqual({});
  });
});

describe("the names a frame carries", () => {
  const GROUP = "120363418525571303@g.us";
  const OTHER = "120363422502290697@g.us";
  const named = { [GROUP]: "Obra da casa", [OTHER]: "Outro grupo" };

  function groupMessage(id: string, jid: string, body = "hi") {
    return {
      key: { id, remoteJid: jid, fromMe: false },
      messageTimestamp: 1_700_000_000,
      message: { conversation: body },
    };
  }

  it("names only the chats the frame is addressed to", () => {
    const frames = [
      ...historyFrames(
        [groupMessage("A", GROUP), groupMessage("B", "5511999@s.whatsapp.net")],
        100_000,
        named,
      ),
    ];

    expect(frames).toHaveLength(1);
    expect(frames[0].groupNames).toEqual({ [GROUP]: "Obra da casa" });
  });

  it("carries nothing for a frame that speaks about no named group", () => {
    const frames = [
      ...historyFrames(
        [groupMessage("A", "5511999@s.whatsapp.net")],
        100_000,
        named,
      ),
    ];

    expect(frames[0].groupNames).toEqual({});
  });

  // A frame packed to the budget with messages from many distinct groups would otherwise
  // carry an entry per group on top of a budget already spent.
  it("charges the names against the same budget as the messages", () => {
    const maxBytes = 4_096;
    const names: Record<string, string> = {};
    const messages = Array.from({ length: 200 }, (_, i) => {
      const jid = `12036340000000000${i}@g.us`;
      names[jid] = `Grupo com um nome de tamanho realista ${i}`;
      return groupMessage(`ID-${i}`, jid, "x".repeat(100));
    });

    const frames = [...historyFrames(messages, maxBytes, names)];

    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) {
      const bytes = Buffer.byteLength(
        JSON.stringify({
          messages: frame.messages,
          groupNames: frame.groupNames,
        }),
        "utf8",
      );
      expect(bytes).toBeLessThan(maxBytes + 1_024);
    }
  });
});
