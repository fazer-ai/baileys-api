import baileys from "@/baileys";
import { BaileysNotConnectedError } from "@/baileys/connection";
import { buildMessageContent } from "@/controllers/connections/helpers";
import { authMiddleware } from "@/middlewares/auth";
import Elysia, { t } from "elysia";
import {
  anyMessageContent,
  chatModification,
  iMessageKey,
  jid,
  phoneNumberParams,
} from "./types";

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
      const { clientName, webhookUrl, webhookVerifyToken, includeMedia } = body;
      await baileys.connect({
        clientName,
        phoneNumber,
        webhookUrl,
        webhookVerifyToken,
        includeMedia,
      });
      return new Response("Connection initiated", {
        status: 200,
      });
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        clientName: t.Optional(
          t.String({
            description: "Name of the client to be used on WhatsApp connection",
            example: "My WhatsApp Client",
          }),
        ),
        webhookUrl: t.String({
          format: "uri",
          description: "URL for receiving updates",
          example: "http://localhost:3026/whatsapp/+1234567890",
        }),
        webhookVerifyToken: t.String({
          minLength: 6,
          description: "Token for verifying webhook",
          example: "a3f4b2",
        }),
        includeMedia: t.Optional(
          t.Boolean({
            description:
              "Include media in messages.upsert event payload as base64 string",
            // TODO(v2): Change default to false.
            default: true,
          }),
        ),
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
  .patch(
    "/:phoneNumber/presence",
    async ({ params, body }) => {
      const { phoneNumber } = params;

      await baileys.sendPresenceUpdate(phoneNumber, body);
      return new Response("Presence update sent successfully", {
        status: 200,
      });
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        type: t.Union(
          [
            t.Literal("unavailable"),
            t.Literal("available"),
            t.Literal("composing"),
            t.Literal("recording"),
            t.Literal("paused"),
          ],
          {
            description:
              "Presence type. `available` is automatically reset to `unavailable` after 60s. `composing` and `recording` are automatically held for ~25s by WhatsApp. `paused` can be used to reset `composing` and `recording` early.",
            example: "available",
          },
        ),
        toJid: t.Optional(
          jid("Required for `composing`, `recording`, and `paused`"),
        ),
      }),
      detail: {
        responses: {
          200: {
            description: "Presence update sent successfully",
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
        jid: jid(),
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
  .post(
    "/:phoneNumber/read-messages",
    async ({ params, body }) => {
      const { phoneNumber } = params;
      const { keys } = body;

      return {
        success: true,
        data: await baileys.readMessages(phoneNumber, keys),
      };
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        keys: t.Array(iMessageKey),
      }),
      detail: {
        responses: {
          200: {
            description: "Message read successfully",
          },
        },
      },
    },
  )
  .post(
    "/:phoneNumber/unread-chat",
    async ({ params, body }) => {
      const { phoneNumber } = params;
      const { jid, lastMessage } = body;

      await baileys.unreadMessages(phoneNumber, jid, lastMessage);
      return new Response("Chat message was unread successfully", {
        status: 200,
      });
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        jid: jid(),
        lastMessage: t.Object(
          {
            key: iMessageKey,
            messageTimestamp: t.Number(),
          },
          {
            description: "Last message in the chat",
          },
        ),
      }),
      detail: {
        responses: {
          200: {
            description: "Chat message was unread successfully",
          },
        },
      },
    },
  )
  .post(
    "/:phoneNumber/chat-modify",
    async ({ params, body }) => {
      const { phoneNumber } = params;
      const { jid, mod } = body;

      await baileys.chatModify(phoneNumber, mod, jid);
      return new Response("Chat modification was successfully applied", {
        status: 200,
      });
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        mod: chatModification,
        jid: jid(),
      }),
      detail: {
        responses: {
          200: {
            description: "Chat modification was successfully applied",
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
        return new Response("Disconnected", {
          status: 200,
        });
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
            description: "Disconnected",
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
