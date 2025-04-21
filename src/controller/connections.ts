import baileys from "@/baileys";
import {
  BaileysAlreadyConnectedError,
  BaileysNotConnectedError,
} from "@/baileys/connection";
import { phoneNumberParams } from "@/controller/common";
import { authMiddleware } from "@/middleware/auth";
import { jidEncode } from "@whiskeysockets/baileys";
import Elysia, { t } from "elysia";

const connectionsController = new Elysia({
  prefix: "/connections",
  detail: {
    tags: ["Connections"],
    security: [{ xApiKey: [] }],
  },
})
  // TODO: Use auth data to limit access to existing connections.
  .use(authMiddleware)
  .post(
    "/:phoneNumber",
    async ({ params, body }) => {
      const { phoneNumber } = params;
      const { clientName, webhookUrl, webhookVerifyToken } = body;
      try {
        await baileys.connect({
          clientName,
          phoneNumber,
          webhookUrl,
          webhookVerifyToken,
        });
      } catch (e) {
        if (e instanceof BaileysAlreadyConnectedError) {
          await baileys.sendPresenceUpdate(phoneNumber, {
            type: "available",
          });
        }
      }
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        clientName: t.Optional(
          t.String({
            description: "Name of the client to be used on WhatsApp connection",
            examples: ["My WhatsApp Client"],
          }),
        ),
        webhookUrl: t.String({
          format: "uri",
          description: "URL for receiving updates",
          examples: ["http://localhost:3026/whatsapp/+1234567890"],
        }),
        webhookVerifyToken: t.String({
          minLength: 6,
          description: "Token for verifying webhook",
          examples: ["a3f4b2"],
        }),
      }),
      detail: {
        responses: {
          200: {
            description: "Connection initiated",
          },
        },
      },
    },
  )
  .post(
    "/:phoneNumber/send-message",
    async ({ params, body }) => {
      const { phoneNumber } = params;
      const {
        type,
        recipient,
        messageContent: rawMessageContent,
        options,
      } = body;
      const supportedTypes = [
        "text",
        "audio",
        "image",
        "video",
        "document",
        "sticker",
      ];

      if (!supportedTypes.includes(type)) {
        return new Response("Unsupported message type", { status: 400 });
      }

      const messageContent = { ...rawMessageContent };

      switch (type) {
        case "audio": {
          messageContent.audio = Buffer.from(messageContent.audio, "base64");
          messageContent.ptt = true;
          break;
        }
        case "image": {
          messageContent.image = Buffer.from(messageContent.image, "base64");
          break;
        }
        case "video": {
          messageContent.video = Buffer.from(messageContent.video, "base64");
          break;
        }
        case "document": {
          messageContent.document = Buffer.from(
            messageContent.document,
            "base64",
          );
          break;
        }
        case "sticker": {
          messageContent.sticker = Buffer.from(
            messageContent.sticker,
            "base64",
          );
          break;
        }
        default:
          break;
      }

      return {
        success: true,
        data: await baileys.sendMessage(phoneNumber, {
          toJid: jidEncode(recipient, "s.whatsapp.net"),
          messageContent,
          options,
        }),
      };
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        type: t.String({
          description: "Type of message to be sent",
          examples: ["text"],
        }),
        recipient: t.String({
          description: "Recipient phone number",
          examples: ["+1234567890"],
        }),
        messageContent: t.Any(),
        options: t.Optional(t.Any()),
      }),
      detail: {
        responses: {
          200: {
            description: "Message sent successfully",
          },
        },
      },
    },
  )
  .delete(
    "/:phoneNumber",
    async ({ params }) => {
      const { phoneNumber } = params;
      try {
        await baileys.logout(phoneNumber);
      } catch (e) {
        if (e instanceof BaileysNotConnectedError) {
          return new Response("Phone number not found", { status: 404 });
        }
        throw e;
      }
    },
    {
      params: phoneNumberParams,
      detail: {
        responses: {
          200: {
            description: "Disconnect initiated",
          },
          404: {
            description: "Phone number not found",
          },
        },
      },
    },
  );

// biome-ignore lint/style/noDefaultExport: <explanation>
export default connectionsController;
