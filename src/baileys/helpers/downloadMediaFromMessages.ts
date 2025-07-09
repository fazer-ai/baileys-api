import path from "node:path";
import {
  type BaileysEventMap,
  downloadContentFromMessage,
  type MediaType,
  type proto,
} from "@whiskeysockets/baileys";
import { file } from "bun";
import { preprocessAudio } from "@/baileys/helpers/preprocessAudio";
import logger from "@/lib/logger";

type MediaMessage =
  | proto.Message.IImageMessage
  | proto.Message.IAudioMessage
  | proto.Message.IVideoMessage
  | proto.Message.IDocumentMessage;

export async function downloadMediaFromMessages(
  messages: BaileysEventMap["messages.upsert"]["messages"],
  options?: {
    includeMedia?: boolean;
  },
): Promise<Record<string, string> | null> {
  const downloadedMedia: Record<string, string> = {};
  const mediaDir = path.resolve(process.cwd(), "media");

  for (const { key, message } of messages) {
    if (!key.id || !message) {
      continue;
    }

    const { mediaMessage, mediaType } = extractMediaMessage(message);
    if (!mediaMessage || !mediaType) {
      continue;
    }

    try {
      const stream = await downloadContentFromMessage(mediaMessage, mediaType);
      let fileBuffer = await streamToBuffer(stream);

      if (message.audioMessage) {
        fileBuffer = await preprocessAudio(fileBuffer, "mp3-high");
        message.audioMessage.mimetype = "audio/mp3";
      }

      if (options?.includeMedia) {
        downloadedMedia[key.id] = fileBuffer.toString("base64");
      }

      await file(path.join(mediaDir, `${key.id}`)).write(fileBuffer);
    } catch (error) {
      logger.error("Failed to download media: %s", error);
    }
  }

  return Object.keys(downloadedMedia).length > 0 ? downloadedMedia : null;
}

function extractMediaMessage(message: proto.IMessage): {
  mediaMessage: MediaMessage | null;
  mediaType: MediaType | null;
} {
  const mediaMapping: [keyof proto.IMessage, MediaType][] = [
    ["imageMessage", "image"],
    ["stickerMessage", "sticker"],
    ["videoMessage", "video"],
    ["audioMessage", "audio"],
    ["documentMessage", "document"],
    ["documentWithCaptionMessage", "document"],
  ];

  for (const [field, type] of mediaMapping) {
    if (message[field]) {
      return {
        mediaMessage: (field === "documentWithCaptionMessage"
          ? message[field]?.message?.documentMessage
          : message[field]) as MediaMessage,
        mediaType: type,
      };
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
