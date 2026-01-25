import Elysia, { t } from "elysia";
import baileys from "@/baileys";
import { BaileysNotConnectedError } from "@/baileys/connection";
import { buildMessageContent } from "@/controllers/connections/helpers";
import { authMiddleware } from "@/middlewares/auth";
import {
  anyMessageContent,
  chatModification,
  iMessageKey,
  iMessageKeyWithId,
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

      await baileys.connect(phoneNumber, body);
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
        syncFullHistory: t.Optional(
          t.Boolean({
            description: "Sync full history of messages on connection.",
            default: false,
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
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        type: t.Union(
          [
            t.Literal("unavailable", { title: "unavailable" }),
            t.Literal("available", { title: "available" }),
            t.Literal("composing", { title: "composing" }),
            t.Literal("recording", { title: "recording" }),
            t.Literal("paused", { title: "paused" }),
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

      const response = await baileys.sendMessage(phoneNumber, {
        jid,
        messageContent: buildMessageContent(messageContent),
      });

      if (!response) {
        return new Response("Message not sent", { status: 500 });
      }

      return {
        data: {
          key: response.key,
          messageTimestamp: response.messageTimestamp,
        },
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
            content: {
              "application/json": {
                schema: t.Object({
                  data: t.Object({
                    key: iMessageKey,
                    messageTimestamp: t.String(),
                  }),
                }),
              },
            },
          },
          500: {
            description: "Message not sent",
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

      await baileys.readMessages(phoneNumber, keys);
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
    "/:phoneNumber/chat-modify",
    async ({ params, body }) => {
      const { phoneNumber } = params;
      const { mod, jid } = body;

      await baileys.chatModify(phoneNumber, mod, jid);
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        mod: chatModification,
        jid: jid(),
      }),
      detail: {
        description:
          "Currently only supports marking chats as read/unread with `markRead` + `lastMessages`.",
        responses: {
          200: {
            description: "Chat modification was successfully applied",
          },
        },
      },
    },
  )
  .post(
    "/:phoneNumber/fetch-message-history",
    ({ params, body }) => {
      const { phoneNumber } = params;
      return baileys.fetchMessageHistory(phoneNumber, body);
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        count: t.Number({
          minimum: 1,
          maximum: 50,
          description: "Number of messages to fetch",
          example: 10,
        }),
        oldestMsgKey: iMessageKey,
        oldestMsgTimestamp: t.Number(),
      }),
      detail: {
        responses: {
          200: { description: "Message history fetched" },
        },
      },
    },
  )
  .post(
    "/:phoneNumber/send-receipts",
    async ({ params, body }) => {
      const { phoneNumber } = params;
      await baileys.sendReceipts(phoneNumber, body);
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        keys: t.Array(iMessageKey),
      }),
      detail: {
        description:
          "Sends read receipts for the provided message keys. Currently only supports sending `received` event. For `read` receipts, use `read-messages` endpoint.",
        responses: {
          200: {
            description: "Receipts sent successfully",
          },
        },
      },
    },
  )
  .delete(
    "/:phoneNumber/messages",
    async ({ params, body }) => {
      const { phoneNumber } = params;

      await baileys.deleteMessage(phoneNumber, body);
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        jid: jid("Chat JID where the message exists"),
        key: iMessageKeyWithId,
      }),
      detail: {
        description:
          "Deletes a message for everyone in the chat. For group messages not sent by you, this requires admin privileges.",
        responses: {
          200: {
            description: "Message deleted successfully",
          },
        },
      },
    },
  )
  .get(
    "/:phoneNumber/profile-picture-url",
    async ({ params, query }) => {
      const { phoneNumber } = params;
      const { jid, type } = query;

      try {
        const profilePictureUrl = await baileys.profilePictureUrl(
          phoneNumber,
          jid,
          type,
        );

        return {
          data: {
            jid,
            profilePictureUrl: profilePictureUrl || null,
          },
        };
      } catch (e) {
        if ((e as Error).message === "item-not-found") {
          return new Response("Profile picture not found", { status: 404 });
        }
        throw e;
      }
    },
    {
      params: phoneNumberParams,
      query: t.Object({
        jid: jid(),
        type: t.Optional(
          t.Union(
            [
              t.Literal("preview", { title: "preview" }),
              t.Literal("image", { title: "image" }),
            ],
            {
              description: "Picture quality type",
              default: "preview",
            },
          ),
        ),
      }),
      detail: {
        responses: {
          200: {
            description: "Profile picture URL retrieved successfully",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        jid: {
                          type: "string",
                          description: "WhatsApp JID of the phone number",
                          example: "551234567890@s.whatsapp.net",
                        },
                        profilePictureUrl: {
                          type: "string",
                          nullable: true,
                          example:
                            "https://pps.whatsapp.net/v/t61.24694-24/...",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          404: { description: "Profile picture not found" },
        },
      },
    },
  )
  .post(
    "/:phoneNumber/on-whatsapp",
    async ({ params, body }) => {
      const { phoneNumber } = params;
      const { jids } = body;

      return baileys.onWhatsApp(phoneNumber, jids);
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        jids: t.Array(
          t.String({
            description: "Phone number formatted as jid",
            pattern: "^\\d{5,15}@s.whatsapp.net$",
            example: "551234567890@s.whatsapp.net",
          }),
          {
            description:
              "Array of phone numbers to check if they are on WhatsApp",
            minItems: 1,
            maxItems: 50,
          },
        ),
      }),
      detail: {
        description: "Check if phone numbers are registered on WhatsApp",
        responses: {
          200: {
            description: "Phone numbers checked successfully",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          jid: {
                            type: "string",
                            description: "WhatsApp JID of the phone number",
                            example: "551234567890@s.whatsapp.net",
                          },
                          exists: {
                            type: "boolean",
                            description:
                              "Whether the phone number is registered on WhatsApp",
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
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
            description: "Disconnected",
          },
          404: {
            description: "Phone number not found",
          },
        },
      },
    },
  );

export default connectionsController;
