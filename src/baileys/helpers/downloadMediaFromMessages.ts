import { unlink } from "node:fs/promises";
import path from "node:path";
import {
  type BaileysEventMap,
  downloadContentFromMessage,
  type MediaType,
  type proto,
} from "@whiskeysockets/baileys";
import { file } from "bun";
import { preprocessAudio } from "@/baileys/helpers/preprocessAudio";
import { instanceId } from "@/cluster/identity";
import { mediaOwnerKey } from "@/cluster/keys";
import config from "@/config";
import { errorToString } from "@/helpers/errorToString";
import logger from "@/lib/logger";
import redis from "@/lib/redis";

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

        const filePath = path.join(mediaDir, `${key.id}`);
        await file(filePath).write(fileBuffer);

        // The file lives on this instance's local disk; record who has it so
        // a proxy can route GET /media/:messageId here. With cleanup enabled
        // the TTL covers the disk window padded by one sweep interval — a
        // file only leaves the disk when the NEXT cleanup pass runs, so the
        // routing key must outlive maxAgeHours by up to that long. With
        // cleanup disabled the file is retained indefinitely, so the routing
        // key must persist too.
        try {
          await redis.set(
            mediaOwnerKey(key.id),
            instanceId,
            config.media.cleanupEnabled
              ? {
                  expiration: {
                    type: "EX",
                    value:
                      config.media.maxAgeHours * 3600 +
                      Math.ceil(config.media.cleanupIntervalMs / 1000),
                  },
                }
              : undefined,
          );
        } catch (error) {
          if (config.cluster.role === "worker") {
            // Behind a proxy the owner key is the only route to this file —
            // without it the blob is unreachable garbage. Remove it and fail
            // the download so the error is visible instead of silent.
            await unlink(filePath).catch(() => {});
            throw error;
          }
          // Standalone serves media straight from local disk; the key is
          // only a routing hint, so keep the file and just log.
          logger.warn(
            "Failed to record media owner for %s: %s",
            key.id,
            errorToString(error),
          );
        }

        // Populated only after the success path: when the worker rejection
        // above fires, the message must not be reported as downloaded.
        if (options?.includeMedia) {
          downloadedMedia[key.id] = fileBuffer.toString("base64");
        }
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
  const headers = [
    message.templateMessage?.hydratedFourRowTemplate,
    message.templateMessage?.hydratedTemplate,
    message.interactiveMessage?.header,
    message.templateMessage?.interactiveMessageTemplate?.header,
    message.buttonsMessage,
  ];

  // Rich headers only carry image, video, or document attachments; audio and
  // stickers don't appear in these header positions, so they're omitted here.
  const headerMapping: [string, MediaType][] = [
    ["imageMessage", "image"],
    ["videoMessage", "video"],
    ["documentMessage", "document"],
  ];

  // A non-null header container doesn't guarantee it carries media, so scan
  // every candidate instead of committing to the first non-null one. The media
  // may live in a later container.
  for (const header of headers) {
    if (!header) {
      continue;
    }
    for (const [field, type] of headerMapping) {
      const node = (header as Record<string, unknown>)[field];
      if (node) {
        return { mediaMessage: node as MediaMessage, mediaType: type };
      }
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
