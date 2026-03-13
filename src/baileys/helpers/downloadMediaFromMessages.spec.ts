import { beforeEach, describe, expect, it, type mock } from "bun:test";
import { downloadContentFromMessage } from "@whiskeysockets/baileys";
import { downloadMediaFromMessages } from "./downloadMediaFromMessages";
import { preprocessAudio } from "./preprocessAudio";

const mockDownloadContent = downloadContentFromMessage as ReturnType<
  typeof mock
>;
const mockPreprocessAudio = preprocessAudio as ReturnType<typeof mock>;

describe("downloadMediaFromMessages", () => {
  beforeEach(() => {
    mockDownloadContent.mockClear();
    if (typeof mockPreprocessAudio.mockClear === "function") {
      mockPreprocessAudio.mockClear();
    }
  });

  it("returns null if messages array is empty", async () => {
    const result = await downloadMediaFromMessages([]);
    expect(result).toBeNull();
  });

  it("returns null for messages without media", async () => {
    const result = await downloadMediaFromMessages([
      {
        key: { id: "msg-1" },
        message: { conversation: "just text" },
      } as any,
    ]);
    expect(result).toBeNull();
  });

  it("skips messages without key.id", async () => {
    const result = await downloadMediaFromMessages([
      {
        key: {},
        message: { imageMessage: { url: "https://example.com/img" } },
      } as any,
    ]);
    expect(result).toBeNull();
  });

  it("skips messages without message object", async () => {
    const result = await downloadMediaFromMessages([
      {
        key: { id: "msg-1" },
        message: null,
      } as any,
    ]);
    expect(result).toBeNull();
  });

  it("downloads image media and saves to file", async () => {
    const messages = [
      {
        key: { id: "msg-img" },
        message: { imageMessage: { url: "https://example.com/img" } },
      },
    ] as any;

    const result = await downloadMediaFromMessages(messages);
    expect(downloadContentFromMessage).toHaveBeenCalledTimes(1);
    // Without includeMedia, media map isn't populated so returns null
    expect(result).toBeNull();
  });

  it("returns base64 data when includeMedia is true", async () => {
    const messages = [
      {
        key: { id: "msg-img" },
        message: { imageMessage: { url: "https://example.com/img" } },
      },
    ] as any;

    const result = await downloadMediaFromMessages(messages, {
      includeMedia: true,
    });
    expect(result).not.toBeNull();
    expect(result?.["msg-img"]).toBeDefined();
    // Should be base64 of the concatenated chunks
    expect(typeof result?.["msg-img"]).toBe("string");
  });

  it("preprocesses audio messages", async () => {
    const messages = [
      {
        key: { id: "msg-audio" },
        message: {
          audioMessage: {
            url: "https://example.com/audio",
            mimetype: "audio/mp3",
          },
        },
      },
    ] as any;

    await downloadMediaFromMessages(messages);
    expect(preprocessAudio).toHaveBeenCalled();
    // Mimetype should be updated
    expect(messages[0].message.audioMessage.mimetype).toBe(
      "audio/ogg; codecs=opus",
    );
  });

  it("handles download errors gracefully", async () => {
    mockDownloadContent.mockRejectedValueOnce(new Error("download failed"));

    const messages = [
      {
        key: { id: "msg-err" },
        message: { imageMessage: { url: "https://example.com/img" } },
      },
    ] as any;

    // Should not throw
    const result = await downloadMediaFromMessages(messages);
    expect(result).toBeNull();
  });

  it("downloads video media", async () => {
    const messages = [
      {
        key: { id: "msg-vid" },
        message: { videoMessage: { url: "https://example.com/vid" } },
      },
    ] as any;

    await downloadMediaFromMessages(messages);
    expect(downloadContentFromMessage).toHaveBeenCalledTimes(1);
  });

  it("downloads document media", async () => {
    const messages = [
      {
        key: { id: "msg-doc" },
        message: { documentMessage: { url: "https://example.com/doc" } },
      },
    ] as any;

    await downloadMediaFromMessages(messages);
    expect(downloadContentFromMessage).toHaveBeenCalledTimes(1);
  });

  it("downloads sticker media", async () => {
    const messages = [
      {
        key: { id: "msg-sticker" },
        message: { stickerMessage: { url: "https://example.com/sticker" } },
      },
    ] as any;

    await downloadMediaFromMessages(messages);
    expect(downloadContentFromMessage).toHaveBeenCalledTimes(1);
  });

  it("extracts document from documentWithCaptionMessage", async () => {
    const messages = [
      {
        key: { id: "msg-doc-caption" },
        message: {
          documentWithCaptionMessage: {
            message: {
              documentMessage: { url: "https://example.com/doc" },
            },
          },
        },
      },
    ] as any;

    await downloadMediaFromMessages(messages);
    expect(downloadContentFromMessage).toHaveBeenCalledTimes(1);
  });

  it("processes multiple messages concurrently in chunks", async () => {
    // Create 5 messages to test chunking (CONCURRENCY = 3)
    const messages = Array.from({ length: 5 }, (_, i) => ({
      key: { id: `msg-${i}` },
      message: { imageMessage: { url: `https://example.com/img-${i}` } },
    })) as any;

    await downloadMediaFromMessages(messages);
    expect(downloadContentFromMessage).toHaveBeenCalledTimes(5);
  });
});
