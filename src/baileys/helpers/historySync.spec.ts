import { describe, expect, it } from "bun:test";
import { historyFrames, stripHistoryPayload } from "./historySync";

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
    expect(frames[0]).toHaveLength(2);
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

    const ids = frames.flat().map((message) => message.key.id);
    expect(ids).toEqual(messages.map((message) => message.key.id));
  });

  it("sends a message larger than the budget on its own", () => {
    const messages = [
      textMessage("SMALL", "x"),
      textMessage("HUGE", "y".repeat(10_000)),
      textMessage("SMALL-2", "z"),
    ];

    const frames = [...historyFrames(messages, 1_024)];

    expect(frames.map((frame) => frame.map((m) => m.key.id))).toEqual([
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
    expect(frames[0]).toHaveLength(10);
  });
});
