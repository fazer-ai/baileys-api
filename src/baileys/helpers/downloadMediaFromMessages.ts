import logger from "@/lib/logger";
import {
  type BaileysEventMap,
  type MediaType,
  downloadContentFromMessage,
  type proto,
} from "@whiskeysockets/baileys";

type MediaMessage =
  | proto.Message.IImageMessage
  | proto.Message.IAudioMessage
  | proto.Message.IVideoMessage
  | proto.Message.IDocumentMessage;

export async function downloadMediaFromMessages(
  messages: BaileysEventMap["messages.upsert"]["messages"],
) {
  const downloadedMedia: Record<string, string> = {};

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

      downloadedMedia[key.id] = buffer.toString("base64");
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
