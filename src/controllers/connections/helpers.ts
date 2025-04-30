import type { AnyMessageContent } from "@whiskeysockets/baileys";
import type { Static } from "elysia";
import type { anyMessageContent } from "./types";

export function buildMessageContent(
  content: Static<typeof anyMessageContent>,
): AnyMessageContent {
  if ("text" in content) {
    return { text: content.text };
  }
  if ("image" in content) {
    return {
      ...content,
      image: Buffer.from(content.image, "base64"),
    };
  }
  if ("video" in content) {
    return {
      ...content,
      video: Buffer.from(content.video, "base64"),
    };
  }
  if ("document" in content) {
    return {
      ...content,
      document: Buffer.from(content.document, "base64"),
    };
  }
  if ("audio" in content) {
    return {
      ...content,
      audio: Buffer.from(content.audio, "base64"),
    };
  }
  if ("react" in content) {
    return { react: content.react };
  }
  if ("buttonReply" in content) {
    return {
      buttonReply: content.buttonReply,
      type: content.type,
    };
  }
  if ("listReply" in content) {
    return { listReply: content.listReply };
  }

  // NOTE: This should never happen
  throw new Error("Invalid message content");
}
