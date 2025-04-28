import baileys from "@/baileys";
import {
  BaileysAlreadyConnectedError,
  BaileysNotConnectedError,
} from "@/baileys/connection";
import { buildMessageContent } from "@/controllers/connections/helpers";
import { authMiddleware } from "@/middlewares/auth";
import Elysia, { t } from "elysia";
import { anyMessageContent, phoneNumberParams } from "./types";

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
      const { jid, messageContent } = body;

      return {
        success: true,
        data: await baileys.sendMessage(phoneNumber, {
          jid,
          messageContent: buildMessageContent(messageContent),
        }),
      };
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        jid: t.String({
          description: "Recipient jid",
          examples: ["551101234567@s.whatsapp.net"],
        }),
        messageContent: anyMessageContent,
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
