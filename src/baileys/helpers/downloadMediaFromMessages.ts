import path from "node:path";
import { preprocessAudio } from "@/baileys/helpers/preprocessAudio";
import logger from "@/lib/logger";
import {
  type BaileysEventMap,
  type MediaType,
  downloadContentFromMessage,
  type proto,
} from "@whiskeysockets/baileys";
import { file } from "bun";

type MediaMessage =
  | proto.Message.IImageMessage
  | proto.Message.IAudioMessage
  | proto.Message.IVideoMessage
  | proto.Message.IDocumentMessage;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <explanation>
export async function downloadMediaFromMessages(
  messages: BaileysEventMap["messages.upsert"]["messages"],
  options?: {
    includeMedia?: boolean;
  },
) {
  const downloadedMedia: Record<string, string> = {};
  const mediaDir = path.resolve(process.cwd(), "media");

  for (const { key, message } of messages) {
    // biome-ignore lint/complexity/useSimplifiedLogicExpression: <explanation>
    if (!key.id || !message) {
      continue;
    }

    const { mediaMessage, mediaType } = extractMediaMessage(message);
    // biome-ignore lint/complexity/useSimplifiedLogicExpression: <explanation>
    if (!mediaMessage || !mediaType) {
      continue;
    }

    let fileBuffer: Buffer;
    try {
      const stream = await downloadContentFromMessage(mediaMessage, mediaType);
      fileBuffer = await streamToBuffer(stream);
    } catch (error) {
      logger.error("Failed to download media: %s", error);
      continue;
    }

    if (message.audioMessage) {
      fileBuffer = await preprocessAudio(fileBuffer, "mp3-high");
      message.audioMessage.mimetype = "audio/mp3";
    }

    // NOTE: This is a workaround for Bun's file writing issue.
    let downloadFailed = false;
    try {
      await file(path.join(mediaDir, `${key.id}`)).write(fileBuffer);
    } catch (error) {
      logger.error("Failed to write media file: %s", error);
      downloadFailed = true;
    }

    if (options?.includeMedia || downloadFailed) {
      downloadedMedia[key.id] = fileBuffer.toString("base64");
    }
  }

  return downloadedMedia;
}

function extractMediaMessage(message: proto.IMessage): {
  mediaMessage: MediaMessage | null;
  mediaType: MediaType | null;
} {
  const mediaMapping: [keyof proto.IMessage, MediaType][] = [
    ["imageMessage", "image"],
    ["stickerMessage", "image"],
    ["videoMessage", "video"],
    ["audioMessage", "audio"],
    ["documentMessage", "document"],
  ];

  for (const [field, type] of mediaMapping) {
    if (message[field]) {
      return { mediaMessage: message[field] as MediaMessage, mediaType: type };
    }
  }

  return { mediaMessage: null, mediaType: null };
}

async function streamToBuffer(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
