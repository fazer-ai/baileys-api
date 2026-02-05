import Elysia, { t } from "elysia";
import baileys from "@/baileys";
import { BaileysNotConnectedError } from "@/baileys/connection";
import {
  buildEditableMessageContent,
  buildMessageContent,
} from "@/controllers/connections/helpers";
import { authMiddleware } from "@/middlewares/auth";
import {
  anyMessageContent,
  chatModification,
  editableMessageContent,
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

      const { messageContent: builtContent, quoted } =
        buildMessageContent(messageContent);

      const response = await baileys.sendMessage(phoneNumber, {
        jid,
        messageContent: builtContent,
        quoted,
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
  .patch(
    "/:phoneNumber/messages",
    async ({ params, body }) => {
      const { phoneNumber } = params;
      const { jid, key, messageContent } = body;

      const response = await baileys.editMessage(phoneNumber, {
        jid,
        key,
        messageContent: buildEditableMessageContent(messageContent),
      });

      if (!response) {
        return new Response("Message not edited", { status: 500 });
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
        jid: jid("Chat JID where the message exists"),
        key: iMessageKeyWithId,
        messageContent: editableMessageContent,
      }),
      detail: {
        description:
          "Edits a previously sent message. Only text messages (including captions) can be edited. The message must have been sent by you and must be within the editable time window (approximately 15 minutes).",
        responses: {
          200: {
            description: "Message edited successfully",
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
            description: "Message not edited",
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
  .get(
    "/:phoneNumber/group-metadata",
    async ({ params, query }) => {
      const { phoneNumber } = params;
      const { jid } = query;

      return baileys.groupMetadata(phoneNumber, jid);
    },
    {
      params: phoneNumberParams,
      query: t.Object({
        jid: jid("Group JID", true),
      }),
      detail: {
        responses: {
          200: {
            description: "Group metadata retrieved successfully",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: {
                      type: "string",
                      description: "Group JID",
                      example: "120363425378794738@g.us",
                    },
                    addressingMode: {
                      type: "string",
                      description: "Addressing mode of the group",
                      example: "lid",
                    },
                    subject: {
                      type: "string",
                      description: "Group name/subject",
                      example: "My Group",
                    },
                    subjectOwner: {
                      type: "string",
                      description: "JID of the user who set the subject",
                      example: "12345678901234@lid",
                    },
                    subjectOwnerPn: {
                      type: "string",
                      description: "Phone number JID of the subject owner",
                      example: "551234567890@s.whatsapp.net",
                    },
                    subjectTime: {
                      type: "number",
                      description: "Timestamp when subject was set",
                    },
                    size: {
                      type: "number",
                      description: "Number of participants in the group",
                    },
                    creation: {
                      type: "number",
                      description: "Timestamp when the group was created",
                    },
                    owner: {
                      type: "string",
                      description: "JID of the group owner",
                      example: "12345678901234@lid",
                    },
                    ownerPn: {
                      type: "string",
                      description: "Phone number JID of the group owner",
                      example: "551234567890@s.whatsapp.net",
                    },
                    owner_country_code: {
                      type: "string",
                      description: "Country code of the group owner",
                      example: "BR",
                    },
                    desc: {
                      type: "string",
                      nullable: true,
                      description: "Group description",
                    },
                    descId: {
                      type: "string",
                      nullable: true,
                      description: "Description ID",
                    },
                    descOwner: {
                      type: "string",
                      nullable: true,
                      description: "JID of the user who set the description",
                    },
                    descTime: {
                      type: "number",
                      nullable: true,
                      description: "Timestamp when description was set",
                    },
                    restrict: {
                      type: "boolean",
                      description:
                        "Whether only admins can change group settings",
                      example: false,
                    },
                    announce: {
                      type: "boolean",
                      description: "Whether only admins can send messages",
                      example: false,
                    },
                    isCommunity: {
                      type: "boolean",
                      description: "Whether the group is a community",
                      example: false,
                    },
                    isCommunityAnnounce: {
                      type: "boolean",
                      description:
                        "Whether the group is a community announcement group",
                      example: false,
                    },
                    joinApprovalMode: {
                      type: "boolean",
                      description:
                        "Whether join requests require admin approval",
                      example: false,
                    },
                    memberAddMode: {
                      type: "boolean",
                      description: "Whether members can add other members",
                      example: true,
                    },
                    participants: {
                      type: "array",
                      description: "List of group participants",
                      items: {
                        type: "object",
                        properties: {
                          id: {
                            type: "string",
                            description: "Participant JID",
                            example: "12345678901234@lid",
                          },
                          phoneNumber: {
                            type: "string",
                            description: "Participant phone number JID",
                            example: "551234567890@s.whatsapp.net",
                          },
                          admin: {
                            type: "string",
                            nullable: true,
                            description:
                              "Admin status: 'superadmin', 'admin', or null",
                            example: "superadmin",
                          },
                        },
                      },
                    },
                    ephemeralDuration: {
                      type: "number",
                      nullable: true,
                      description:
                        "Duration in seconds for disappearing messages",
                      example: 604800,
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
  .post(
    "/:phoneNumber/group-participants",
    async ({ params, body }) => {
      const { phoneNumber } = params;
      const { jid, participants, action } = body;

      return baileys.groupParticipants(phoneNumber, jid, participants, action);
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        jid: jid("Group JID", true),
        participants: t.Array(jid(), {
          description: "Array of participant JIDs",
          minItems: 1,
        }),
        action: t.Union(
          [
            t.Literal("add", { title: "add" }),
            t.Literal("remove", { title: "remove" }),
            t.Literal("promote", { title: "promote" }),
            t.Literal("demote", { title: "demote" }),
          ],
          {
            description:
              "Action to perform on participants. `add` adds participants, `remove` removes them, `promote` makes them admins, `demote` removes admin privileges.",
            example: "add",
          },
        ),
      }),
      detail: {
        description: "Manage group participants (add, remove, promote, demote)",
        responses: {
          200: {
            description: "Participants updated successfully",
          },
        },
      },
    },
  )
  .post(
    "/:phoneNumber/group-subject",
    async ({ params, body }) => {
      const { phoneNumber } = params;
      const { jid, subject } = body;

      await baileys.groupUpdateSubject(phoneNumber, jid, subject);
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        jid: jid("Group JID", true),
        subject: t.String({
          description: "New group subject (name)",
          minLength: 1,
          maxLength: 100,
          example: "My Group Name",
        }),
      }),
      detail: {
        description: "Update group subject (name)",
        responses: {
          200: {
            description: "Group subject updated successfully",
          },
        },
      },
    },
  )
  .post(
    "/:phoneNumber/group-description",
    async ({ params, body }) => {
      const { phoneNumber } = params;
      const { jid, description } = body;

      await baileys.groupUpdateDescription(phoneNumber, jid, description);
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        jid: jid("Group JID", true),
        description: t.Optional(
          t.String({
            description: "New group description",
            maxLength: 2048,
            example: "This is my group description",
          }),
        ),
      }),
      detail: {
        description: "Update group description",
        responses: {
          200: {
            description: "Group description updated successfully",
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
