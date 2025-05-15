import { mkdir } from "node:fs/promises";
import path from "node:path";
import { preprocessAudio } from "@/baileys/helpers/preprocessAudio";
import logger from "@/lib/logger";
import {
  type BaileysEventMap,
  type MediaType,
  downloadContentFromMessage,
  type proto,
} from "@whiskeysockets/baileys";
import { write } from "bun";

type MediaMessage =
  | proto.Message.IImageMessage
  | proto.Message.IAudioMessage
  | proto.Message.IVideoMessage
  | proto.Message.IDocumentMessage;

export async function downloadMediaFromMessages(
  messages: BaileysEventMap["messages.upsert"]["messages"],
  options?: {
    returnBuffer?: boolean;
  },
) {
  const downloadedMedia: Record<string, string> = {};
  const mediaDir = path.resolve(process.cwd(), "media");
  await mkdir(mediaDir, { recursive: true });

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

    try {
      const stream = await downloadContentFromMessage(mediaMessage, mediaType);
      const buffer = await streamToBuffer(stream);

      let fileBuffer = buffer;
      if (message.audioMessage) {
        fileBuffer = await preprocessAudio(buffer, "mp3-high");
        message.audioMessage.mimetype = "audio/mp3";
      }

      write(path.join(mediaDir, `${key.id}`), fileBuffer);

      if (options?.returnBuffer) {
        downloadedMedia[key.id] = fileBuffer.toString("base64");
      }
    } catch (error) {
      logger.error("Failed to download media: %s", error);
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
