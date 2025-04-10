import {
  type BaileysEventMap,
  type MediaType,
  downloadContentFromMessage,
  type proto,
} from "@whiskeysockets/baileys";

export class MediaHandler {
  private messages: BaileysEventMap["messages.upsert"]["messages"];

  constructor(data: BaileysEventMap["messages.upsert"]) {
    this.messages = data.messages;
  }

  async process() {
    const results = await Promise.all(
      this.messages.map(async (message) => {
        const { message: msg } = message;
        if (msg?.imageMessage) {
          return await this.downloadMedia(msg.imageMessage, "image");
        }

        return null;
      }),
    );
    return results.filter((result) => result !== null).length === 0
      ? undefined
      : results;
  }

  async downloadMedia(media: proto.Message.IImageMessage, type: MediaType) {
    const stream = await downloadContentFromMessage(media, type);

    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
    }
    return buffer.toString("base64");
  }
}
