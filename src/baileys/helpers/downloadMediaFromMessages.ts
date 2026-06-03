import path from "node:path";
import {
  type BaileysEventMap,
  downloadContentFromMessage,
  type MediaType,
  type proto,
} from "@whiskeysockets/baileys";
import { file } from "bun";
import { preprocessAudio } from "@/baileys/helpers/preprocessAudio";
import { errorToString } from "@/helpers/errorToString";
import logger from "@/lib/logger";

type MediaMessage =
  | proto.Message.IImageMessage
  | proto.Message.IAudioMessage
  | proto.Message.IVideoMessage
  | proto.Message.IDocumentMessage;

const CONCURRENCY = 3;

export async function downloadMediaFromMessages(
  messages: BaileysEventMap["messages.upsert"]["messages"],
  options?: {
    includeMedia?: boolean;
  },
): Promise<Record<string, string> | null> {
  const downloadedMedia: Record<string, string> = {};
  const mediaDir = path.resolve(process.cwd(), "media");

  const downloadableMessages = messages.filter(
    ({ key, message }) =>
      key.id && message && extractMediaMessage(message).mediaMessage,
  );

  if (downloadableMessages.length === 0) {
    return null;
  }

  for (let i = 0; i < downloadableMessages.length; i += CONCURRENCY) {
    const chunk = downloadableMessages.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map(async ({ key, message }) => {
        if (!key.id || !message) {
          return;
        }

        const { mediaMessage, mediaType } = extractMediaMessage(message);
        if (!mediaMessage || !mediaType) {
          return;
        }

        const stream = await downloadContentFromMessage(
          mediaMessage,
          mediaType,
        );
        let fileBuffer = await streamToBuffer(stream);

        if (message.audioMessage) {
          fileBuffer = await preprocessAudio(fileBuffer, "ogg-low");
          message.audioMessage.mimetype = "audio/ogg; codecs=opus";
        }

        if (options?.includeMedia) {
          downloadedMedia[key.id] = fileBuffer.toString("base64");
        }

        await file(path.join(mediaDir, `${key.id}`)).write(fileBuffer);
      }),
    );

    for (const result of results) {
      if (result.status === "rejected") {
        logger.error(
          "Failed to download media: %s",
          errorToString(result.reason),
        );
      }
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

  return (
    extractHeaderMediaMessage(message) ?? {
      mediaMessage: null,
      mediaType: null,
    }
  );
}

// "Rich" messages (template / interactive / buttons) can carry a media header
// nested inside their payload instead of at the top level, e.g. an invoice PDF
// in a template header. Surface it so it is downloaded and served like any
// other attachment.
function extractHeaderMediaMessage(message: proto.IMessage): {
  mediaMessage: MediaMessage;
  mediaType: MediaType;
} | null {
  const header =
    message.templateMessage?.hydratedFourRowTemplate ??
    message.templateMessage?.hydratedTemplate ??
    message.interactiveMessage?.header ??
    message.templateMessage?.interactiveMessageTemplate?.header ??
    message.buttonsMessage;
  if (!header) {
    return null;
  }

  const headerMapping: [string, MediaType][] = [
    ["imageMessage", "image"],
    ["videoMessage", "video"],
    ["documentMessage", "document"],
  ];

  for (const [field, type] of headerMapping) {
    const node = (header as Record<string, unknown>)[field];
    if (node) {
      return { mediaMessage: node as MediaMessage, mediaType: type };
    }
  }

  return null;
}

async function streamToBuffer(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
