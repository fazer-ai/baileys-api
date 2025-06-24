import { describe, it } from "bun:test";

describe("downloadMediaFromMessages", () => {
  describe("#downloadMediaFromMessages", () => {
    it.todo("returns null if messages array is empty");
    it.todo("skips messages without key.id or message object");
    it.todo("downloads media and save it to a file");
    it.todo("returns base64 data when includeMedia is true");
    it.todo("preprocess audio messages");
    it.todo("handles errors during media download");
    it.todo("returns null if no media was downloaded");
  });

  describe("#extractMediaMessage", () => {
    it.todo("extract media from an imageMessage");
    it.todo("extract media from a stickerMessage");
    it.todo("extract media from a videoMessage");
    it.todo("extract media from an audioMessage");
    it.todo("extract media from a documentMessage");
    it.todo("media from a documentWithCaptionMessage");
    it.todo("returns null for messages without media mapped");
  });

  describe("#streamToBuffer", () => {
    it.todo("converts a stream to buffer");
  });
});
