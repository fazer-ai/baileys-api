import { describe, expect, it } from "bun:test";
import { buildEditableMessageContent, buildMessageContent } from "./helpers";

describe("buildMessageContent", () => {
  describe("text messages", () => {
    it("builds a text message content", () => {
      const result = buildMessageContent({ text: "Hello world!" });
      expect(result.messageContent).toEqual({ text: "Hello world!" });
      expect(result.quoted).toBeUndefined();
    });

    it("builds a text message with mentions", () => {
      const result = buildMessageContent({
        text: "Hello @user!",
        mentions: ["5511999999999@s.whatsapp.net"],
      });
      expect(result.messageContent).toEqual({
        text: "Hello @user!",
        mentions: ["5511999999999@s.whatsapp.net"],
      });
    });

    it("builds a text message with quoted message", () => {
      const result = buildMessageContent({
        text: "Reply",
        quotedMessage: {
          key: { id: "msg-123" },
          message: { conversation: "Original" },
        },
      });
      expect(result.messageContent).toEqual({ text: "Reply" });
      expect(result.quoted).toEqual({
        key: { id: "msg-123" },
        message: { conversation: "Original" },
      });
    });
  });

  describe("image messages", () => {
    it("decodes base64 image data into a Buffer", () => {
      const base64Image = Buffer.from("fake-image").toString("base64");
      const result = buildMessageContent({ image: base64Image });
      expect(result.messageContent).toEqual({
        image: Buffer.from("fake-image"),
      });
    });

    it("includes caption with image", () => {
      const base64Image = Buffer.from("fake-image").toString("base64");
      const result = buildMessageContent({
        image: base64Image,
        caption: "A photo",
      });
      expect((result.messageContent as { caption: string }).caption).toBe(
        "A photo",
      );
    });
  });

  describe("video messages", () => {
    it("decodes base64 video data into a Buffer", () => {
      const base64Video = Buffer.from("fake-video").toString("base64");
      const result = buildMessageContent({ video: base64Video });
      expect(result.messageContent).toEqual({
        video: Buffer.from("fake-video"),
      });
    });
  });

  describe("document messages", () => {
    it("decodes base64 document data into a Buffer", () => {
      const base64Doc = Buffer.from("fake-doc").toString("base64");
      const result = buildMessageContent({
        document: base64Doc,
        fileName: "test.pdf",
      });
      expect(result.messageContent).toEqual({
        document: Buffer.from("fake-doc"),
        fileName: "test.pdf",
      });
    });
  });

  describe("audio messages", () => {
    it("decodes base64 audio data into a Buffer", () => {
      const base64Audio = Buffer.from("fake-audio").toString("base64");
      const result = buildMessageContent({ audio: base64Audio });
      expect(result.messageContent).toEqual({
        audio: Buffer.from("fake-audio"),
      });
    });

    it("includes ptt flag for voice notes", () => {
      const base64Audio = Buffer.from("fake-audio").toString("base64");
      const result = buildMessageContent({ audio: base64Audio, ptt: true });
      expect((result.messageContent as { ptt: boolean }).ptt).toBe(true);
    });
  });

  describe("reaction messages", () => {
    it("builds a reaction message", () => {
      const result = buildMessageContent({
        react: { key: { id: "msg-123" }, text: "👍" },
      });
      expect(result.messageContent).toEqual({
        react: { key: { id: "msg-123" }, text: "👍" },
      });
      expect(result.quoted).toBeUndefined();
    });
  });
});

describe("buildEditableMessageContent", () => {
  it("returns the content as-is", () => {
    const content = { text: "Updated text" };
    expect(buildEditableMessageContent(content)).toEqual(content);
  });

  it("preserves mentions", () => {
    const content = {
      text: "Updated @user",
      mentions: ["5511999999999@s.whatsapp.net"],
    };
    expect(buildEditableMessageContent(content)).toEqual(content);
  });
});
