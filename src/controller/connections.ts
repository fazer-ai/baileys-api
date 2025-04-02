import baileys from "@/baileys";
import {
  BaileysAlreadyConnectedError,
  BaileysNotConnectedError,
} from "@/baileys/connection";
import {
  PhoneStatusNotFoundError,
  phoneNumberParams,
} from "@/controller/common";
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
  .get(
    "/:phoneNumber/fetch/phone/:phoneNumberToFetch",
    async ({ params }) => {
      const { phoneNumber, phoneNumberToFetch } = params;
      try {
        const fetchResponse = await baileys.fetchStatus(
          phoneNumber,
          jidEncode(phoneNumberToFetch, "s.whatsapp.net"),
        );

        return {
          success: true,
          data: fetchResponse,
        };
      } catch (e) {
        if (e instanceof BaileysNotConnectedError) {
          return new Response("Phone number not found", { status: 401 });
        }
        if (e instanceof PhoneStatusNotFoundError) {
          return new Response("Status not found", { status: 404 });
        }
        throw e;
      }
    },
    {
      params: t.Object({
        phoneNumber: t.String({
          minLength: 13,
          maxLength: 14,
          description: "Phone number for connection",
        }),
        phoneNumberToFetch: t.String({
          minLength: 13,
          maxLength: 14,
          description: "Phone number to fetch status from",
        }),
      }),
      detail: {
        responses: {
          200: {
            description: "Fetch response",
          },
          401: {
            description: "Phone number not found",
          },
          404: {
            description: "Status not found",
          },
        },
      },
    },
  )
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
      const { type, recipient, message } = body;

      try {
        if (type !== "text") {
          return new Response("Only text messages are supported", {
            status: 400,
          });
        }

        const result = await baileys.sendMessage(phoneNumber, {
          toJid: jidEncode(recipient, "s.whatsapp.net"),
          conversation: message,
        });

        return { success: true, data: result };
      } catch (e) {
        if (e instanceof BaileysNotConnectedError) {
          return new Response("Phone number not found", { status: 404 });
        }
        throw e;
      }
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
        message: t.String({
          description: "Message to be sent",
          examples: ["Hello, this is a test message"],
        }),
      }),
      detail: {
        responses: {
          200: {
            description: "Message sent successfully",
          },
          400: {
            description: "Only text messages are supported",
          },
          404: {
            description: "Phone number not found",
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
