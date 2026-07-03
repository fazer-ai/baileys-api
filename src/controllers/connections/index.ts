import Elysia, { t } from "elysia";
import baileys from "@/baileys";
import {
  BaileysConnectionForbiddenError,
  BaileysNotConnectedError,
} from "@/baileys/connection";
import {
  InvalidNoiseCandidateError,
  mapSessionToCreds,
} from "@/baileys/importSession";
import coordinator from "@/cluster";
import { BaileysConnectionOwnedElsewhereError } from "@/cluster/coordinator";
import { resolveMisdirectedRequest } from "@/cluster/workerRouting";
import {
  buildEditableMessageContent,
  buildMessageContent,
} from "@/controllers/connections/helpers";
import { withIdempotency } from "@/helpers/withIdempotency";
import { authMiddleware } from "@/middlewares/auth";
import {
  anyJid,
  anyMessageContent,
  chatModification,
  connectionOptionsSchema,
  editableMessageContent,
  extractedSession,
  groupJid,
  iMessageKey,
  iMessageKeyWithId,
  phoneNumberParams,
  userJid,
} from "./types";

const connectionsController = new Elysia({
  prefix: "/connections",
  detail: {
    tags: ["Connections"],
    security: [{ xApiKey: [] }],
    responses: {
      403: {
        description:
          "Forbidden — the API key does not own this connection. Returned when a connection is bound to a different API key.",
      },
      421: {
        description:
          "Misdirected Request — in cluster mode, this instance does not own the connection. The owning instance id is in the x-baileys-owner header; a proxy re-routes the request there. Not returned for POST /connections/{phoneNumber} (explicit takeover).",
        headers: {
          "x-baileys-owner": {
            description: "Instance id of the connection owner",
            schema: { type: "string" },
          },
        },
      },
    },
  },
})
  .use(authMiddleware)
  .onBeforeHandle(async ({ params, apiKeyHash, set, request, path }) => {
    const phoneNumber = (params as { phoneNumber?: string })?.phoneNumber;
    if (!phoneNumber) {
      return;
    }

    // Worker role: a request for a phone owned by another live instance is
    // answered with 421 so the proxy invalidates its route cache and
    // re-sends to the owner. This runs BEFORE the access check: during a
    // lease transition the local metadata (apiKeyHash) can lag the new
    // owner's writes, and answering 403 off that stale copy would mask the
    // misdirect the proxy knows how to recover from.
    // POST /connections/:phone and .../import-session are exempt — both are
    // explicit takeovers and resolve ownership in the coordinator (409 when the
    // owner is alive).
    const decodedPath = decodeURIComponent(path);
    const isConnectTakeover =
      request.method === "POST" &&
      (decodedPath === `/connections/${phoneNumber}` ||
        decodedPath === `/connections/${phoneNumber}/import-session`);
    if (!isConnectTakeover) {
      const owner = await resolveMisdirectedRequest(phoneNumber);
      if (owner) {
        set.status = 421;
        set.headers["x-baileys-owner"] = owner;
        return {
          error: "Misdirected Request",
          message: "Connection is owned by another instance",
        };
      }
    }

    try {
      await baileys.verifyConnectionAccess(phoneNumber, apiKeyHash);
    } catch (e) {
      if (e instanceof BaileysConnectionForbiddenError) {
        set.status = 403;
        return { error: "Forbidden", message: e.message };
      }
      throw e;
    }
  })
  .post(
    "/:phoneNumber",
    async ({ params, body, apiKeyHash, set }) => {
      const { phoneNumber } = params;

      // Goes through the coordinator so the connect is backed by a lease:
      // an explicit POST is authoritative and takes the identity over.
      try {
        await coordinator.connectWithLease(phoneNumber, {
          ...body,
          apiKeyHash: apiKeyHash ?? undefined,
        });
      } catch (e) {
        if (e instanceof BaileysConnectionOwnedElsewhereError) {
          set.status = 409;
          set.headers["x-baileys-owner"] = e.ownerInstanceId;
          return {
            error: "Conflict",
            message: "Connection is owned by another live instance",
          };
        }
        throw e;
      }
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        ...connectionOptionsSchema,
      }),
      detail: {
        responses: {
          200: {
            description: "Connection initiated",
          },
          409: {
            description:
              "Conflict — in cluster mode, the connection is owned by another live instance (id in the x-baileys-owner header); a proxy re-routes the takeover there instead of stealing a healthy socket.",
            headers: {
              "x-baileys-owner": {
                description: "Instance id of the connection owner",
                schema: { type: "string" },
              },
            },
          },
        },
      },
    },
  )
  .post(
    "/:phoneNumber/import-session",
    async ({ params, body, apiKeyHash, set }) => {
      const { phoneNumber } = params;
      const { session, candidateIndex, ...options } = body;

      // Transplant an already-linked WhatsApp Web session: map the extracted
      // creds, seed them under the lease, and connect — the socket resumes as a
      // registered companion (no QR). Like POST /:phoneNumber it is an explicit
      // takeover, so a live owner elsewhere surfaces as 409.
      try {
        const index = candidateIndex ?? 0;
        const creds = mapSessionToCreds(session, index);
        await coordinator.importSessionWithLease(
          phoneNumber,
          creds,
          session.noiseCandidates,
          index,
          { ...options, apiKeyHash: apiKeyHash ?? undefined },
        );
      } catch (e) {
        if (e instanceof InvalidNoiseCandidateError) {
          set.status = 422;
          return { error: "Unprocessable Entity", message: e.message };
        }
        if (e instanceof BaileysConnectionOwnedElsewhereError) {
          set.status = 409;
          set.headers["x-baileys-owner"] = e.ownerInstanceId;
          return {
            error: "Conflict",
            message: "Connection is owned by another live instance",
          };
        }
        throw e;
      }
      set.status = 202;
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        session: extractedSession,
        candidateIndex: t.Optional(
          t.Number({
            minimum: 0,
            default: 0,
            description:
              "Index into session.noiseCandidates to try first (only one candidate is the real pair).",
          }),
        ),
        ...connectionOptionsSchema,
      }),
      detail: {
        summary: "Import an extracted WhatsApp Web session (no QR)",
        responses: {
          202: { description: "Session import accepted; connecting" },
          409: {
            description:
              "Conflict — in cluster mode, the connection is owned by another live instance (id in the x-baileys-owner header).",
            headers: {
              "x-baileys-owner": {
                description: "Instance id of the connection owner",
                schema: { type: "string" },
              },
            },
          },
          422: {
            description:
              "Unprocessable Entity — the requested noise candidate index is out of range.",
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
          anyJid("Required for `composing`, `recording`, and `paused`"),
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
    "/:phoneNumber/presence-subscribe",
    async ({ params, body }) => {
      const { phoneNumber } = params;
      const { jids } = body;

      const result = await baileys.presenceSubscribe(phoneNumber, jids);
      return { data: result };
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        jids: t.Array(
          anyJid("WhatsApp JID to subscribe to presence updates for"),
          {
            description: "Array of JIDs to subscribe to presence updates",
            minItems: 1,
            maxItems: 50,
          },
        ),
      }),
      detail: {
        description:
          "Subscribe to presence updates for one or more JIDs. Presence updates will be forwarded via the `presence.update` webhook event. Subscriptions are ephemeral, so re-subscribe periodically for continuous monitoring. LID JIDs are automatically resolved to phone number JIDs before subscribing.",
        responses: {
          200: {
            description: "Presence subscription result",
          },
        },
      },
    },
  )
  .post(
    "/:phoneNumber/send-message",
    async ({ params, body }) => {
      const { phoneNumber } = params;
      const { jid, messageContent, chatwootMessageId } = body;

      const idempotencyKey =
        chatwootMessageId !== undefined && chatwootMessageId !== null
          ? `@baileys-api:idempotency:send-message:${phoneNumber}:${String(chatwootMessageId)}`
          : null;

      let result: Awaited<ReturnType<typeof withIdempotency>>;
      try {
        result = await withIdempotency(idempotencyKey, async () => {
          const { messageContent: builtContent, quoted } =
            buildMessageContent(messageContent);

          const response = await baileys.sendMessage(phoneNumber, {
            jid,
            messageContent: builtContent,
            quoted,
          });

          if (!response) return null;

          return {
            key: response.key,
            messageTimestamp: response.messageTimestamp,
          };
        });
      } catch (e) {
        // The phone has no live socket on this instance (never connected, or
        // dropped mid-request). Surface it as 404 instead of a generic 500 so
        // callers can distinguish "not connected" from a real send failure.
        // withIdempotency already released the lock on throw, so a retry after
        // reconnect is free to proceed.
        if (e instanceof BaileysNotConnectedError) {
          return new Response("Phone number not connected", { status: 404 });
        }
        throw e;
      }

      if (result.status === "processing") {
        return new Response("Message is already being processed", {
          status: 409,
        });
      }

      if (result.status === "failed") {
        return new Response("Message not sent", { status: 500 });
      }

      return { data: result.value };
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        jid: anyJid(),
        messageContent: anyMessageContent,
        chatwootMessageId: t.Optional(t.Union([t.String(), t.Number()])),
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
          404: {
            description: "Phone number not connected",
          },
          409: {
            description: "Message is already being processed",
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
        jid: anyJid(),
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
        jid: anyJid("Chat JID where the message exists"),
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
        jid: anyJid("Chat JID where the message exists"),
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
        jid: anyJid(),
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
  .get(
    "/:phoneNumber/reachout-timelock",
    async ({ params }) => {
      const { phoneNumber } = params;

      try {
        const reachoutTimelock = await baileys.getReachoutTimelock(phoneNumber);
        return { data: reachoutTimelock };
      } catch (e) {
        if (e instanceof BaileysNotConnectedError) {
          return new Response("Phone number not connected", { status: 404 });
        }
        throw e;
      }
    },
    {
      params: phoneNumberParams,
      detail: {
        description:
          "Fetch the account's reach-out time-lock state — the restriction behind error 463 ('account restricted') that blocks starting new chats. Read-only: queries WhatsApp directly (MEX) without sending a message, so it is safe to call on a restricted account.",
        responses: {
          200: {
            description: "Reach-out time-lock state retrieved successfully",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        isActive: {
                          type: "boolean",
                          description:
                            "Whether the reach-out time-lock is currently enforced",
                          example: false,
                        },
                        timeEnforcementEnds: {
                          type: "string",
                          format: "date-time",
                          nullable: true,
                          description:
                            "When the current enforcement window ends",
                        },
                        enforcementType: {
                          type: "string",
                          description:
                            "Reason/type of enforcement. 'DEFAULT' means no restriction.",
                          example: "DEFAULT",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          404: { description: "Phone number not connected" },
        },
      },
    },
  )
  .get(
    "/:phoneNumber/new-chat-cap",
    async ({ params }) => {
      const { phoneNumber } = params;

      try {
        const newChatCap = await baileys.getNewChatMessageCap(phoneNumber);
        return { data: newChatCap };
      } catch (e) {
        if (e instanceof BaileysNotConnectedError) {
          return new Response("Phone number not connected", { status: 404 });
        }
        throw e;
      }
    },
    {
      params: phoneNumberParams,
      detail: {
        description:
          "Fetch the account's new-chat message cap and usage — an antecedent indicator of the 463 restriction (how many new conversations can still be started this cycle). Read-only: queries WhatsApp directly (MEX) without sending a message.",
        responses: {
          200: {
            description: "New-chat message cap retrieved successfully",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        total_quota: {
                          type: "number",
                          description:
                            "Total new-chat messages allowed in the current cycle",
                          example: 100,
                        },
                        used_quota: {
                          type: "number",
                          description:
                            "New-chat messages already used in the current cycle",
                          example: 0,
                        },
                        cycle_start_timestamp: {
                          type: "string",
                          nullable: true,
                          description: "Unix timestamp of the cycle start",
                        },
                        cycle_end_timestamp: {
                          type: "string",
                          nullable: true,
                          description: "Unix timestamp of the cycle end",
                        },
                        server_sent_timestamp: {
                          type: "string",
                          nullable: true,
                          description:
                            "Unix timestamp when WhatsApp produced this snapshot",
                        },
                        ote_status: {
                          type: "string",
                          nullable: true,
                          description:
                            "One-time-engagement cap status (NOT_ELIGIBLE, ELIGIBLE, ACTIVE_IN_CURRENT_CYCLE, EXHAUSTED)",
                        },
                        mv_status: {
                          type: "string",
                          nullable: true,
                          description:
                            "Multi-vertical cap status (NOT_ELIGIBLE, NOT_ACTIVE, ACTIVE, ACTIVE_UPGRADE_AVAILABLE)",
                        },
                        capping_status: {
                          type: "string",
                          nullable: true,
                          description:
                            "Overall capping status (NONE, FIRST_WARNING, SECOND_WARNING, CAPPED)",
                          example: "NONE",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          404: { description: "Phone number not connected" },
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
    "/:phoneNumber/business-profile",
    async ({ params, query }) => {
      const { phoneNumber } = params;
      const { jid } = query;

      return baileys.getBusinessProfile(phoneNumber, jid);
    },
    {
      params: phoneNumberParams,
      query: t.Object({
        jid: userJid(),
      }),
      detail: {
        description: "Get business profile of a WhatsApp Business account",
        responses: {
          200: {
            description: "Business profile retrieved successfully",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    wid: {
                      type: "string",
                      description: "WhatsApp ID of the business",
                      example: "551234567890@s.whatsapp.net",
                    },
                    description: {
                      type: "string",
                      description: "Business description",
                      example: "We are a company that sells products",
                    },
                    email: {
                      type: "string",
                      nullable: true,
                      description: "Business email",
                      example: "contact@business.com",
                    },
                    website: {
                      type: "array",
                      items: { type: "string" },
                      description: "Business websites",
                      example: ["https://business.com"],
                    },
                    category: {
                      type: "string",
                      nullable: true,
                      description: "Business category",
                      example: "Retail",
                    },
                    address: {
                      type: "string",
                      nullable: true,
                      description: "Business address",
                      example: "123 Main St, City",
                    },
                    business_hours: {
                      type: "object",
                      description: "Business hours configuration",
                      properties: {
                        timezone: {
                          type: "string",
                          description: "Timezone of the business",
                          example: "America/Sao_Paulo",
                        },
                        config: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              day_of_week: { type: "string" },
                              mode: { type: "string" },
                              open_time: { type: "number" },
                              close_time: { type: "number" },
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
        jid: groupJid(),
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
      const { jid, participant, action } = body;

      return baileys.groupParticipants(phoneNumber, jid, [participant], action);
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        jid: groupJid(),
        participant: userJid(),
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
        jid: groupJid(),
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
        jid: groupJid(),
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
  .post(
    "/:phoneNumber/update-profile-picture",
    async ({ params, body }) => {
      const { phoneNumber } = params;
      const { jid, image } = body;

      const buffer = Buffer.from(image, "base64");
      await baileys.updateProfilePicture(phoneNumber, jid, buffer);
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        jid: anyJid(),
        image: t.String({
          description: "Base64-encoded image data",
        }),
      }),
      detail: {
        description: "Update profile picture for a contact or group",
        responses: {
          200: {
            description: "Profile picture updated successfully",
          },
        },
      },
    },
  )
  .post(
    "/:phoneNumber/group-create",
    async ({ params, body }) => {
      const { phoneNumber } = params;
      const { subject, participants } = body;

      return baileys.groupCreate(phoneNumber, subject, participants);
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        subject: t.String({
          description: "Group name/subject",
          minLength: 1,
          maxLength: 100,
          example: "My New Group",
        }),
        participants: t.Array(userJid("Participant to add to the group"), {
          description: "Array of participant JIDs to add to the group",
          minItems: 1,
        }),
      }),
      detail: {
        description: "Create a new WhatsApp group",
        responses: {
          200: {
            description: "Group created successfully",
          },
        },
      },
    },
  )
  .post(
    "/:phoneNumber/group-leave",
    async ({ params, body }) => {
      const { phoneNumber } = params;
      const { jid } = body;

      await baileys.groupLeave(phoneNumber, jid);
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        jid: groupJid(),
      }),
      detail: {
        description: "Leave a WhatsApp group",
        responses: {
          200: {
            description: "Left group successfully",
          },
        },
      },
    },
  )
  .get(
    "/:phoneNumber/group-request-participants-list",
    async ({ params, query }) => {
      const { phoneNumber } = params;
      const { jid } = query;

      return baileys.groupRequestParticipantsList(phoneNumber, jid);
    },
    {
      params: phoneNumberParams,
      query: t.Object({
        jid: groupJid(),
      }),
      detail: {
        description: "List pending join requests for a group",
        responses: {
          200: {
            description: "Pending join requests retrieved successfully",
          },
        },
      },
    },
  )
  .post(
    "/:phoneNumber/group-request-participants-update",
    async ({ params, body }) => {
      const { phoneNumber } = params;
      const { jid, participants, action } = body;

      return baileys.groupRequestParticipantsUpdate(
        phoneNumber,
        jid,
        participants,
        action,
      );
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        jid: groupJid(),
        participants: t.Array(userJid("Participant to approve or reject"), {
          description: "Array of participant JIDs to approve or reject",
          minItems: 1,
        }),
        action: t.Union(
          [
            t.Literal("approve", { title: "approve" }),
            t.Literal("reject", { title: "reject" }),
          ],
          {
            description: "Action to perform on join requests",
            example: "approve",
          },
        ),
      }),
      detail: {
        description: "Approve or reject pending join requests for a group",
        responses: {
          200: {
            description: "Join requests updated successfully",
          },
        },
      },
    },
  )
  .get(
    "/:phoneNumber/group-invite-code",
    async ({ params, query }) => {
      const { phoneNumber } = params;
      const { jid } = query;

      const code = await baileys.groupInviteCode(phoneNumber, jid);

      return { data: { jid, inviteCode: code || null } };
    },
    {
      params: phoneNumberParams,
      query: t.Object({
        jid: groupJid(),
      }),
      detail: {
        description: "Get the invite code for a group",
        responses: {
          200: {
            description: "Invite code retrieved successfully",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        jid: { type: "string" },
                        inviteCode: { type: "string", nullable: true },
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
  .post(
    "/:phoneNumber/group-revoke-invite",
    async ({ params, body }) => {
      const { phoneNumber } = params;
      const { jid } = body;

      const newCode = await baileys.groupRevokeInvite(phoneNumber, jid);

      return { data: { jid, inviteCode: newCode || null } };
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        jid: groupJid(),
      }),
      detail: {
        description:
          "Revoke the current invite code and generate a new one for a group",
        responses: {
          200: {
            description: "Invite code revoked successfully",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        jid: { type: "string" },
                        inviteCode: { type: "string", nullable: true },
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
  .post(
    "/:phoneNumber/group-accept-invite",
    async ({ params, body }) => {
      const { phoneNumber } = params;
      const { code } = body;

      const groupJid = await baileys.groupAcceptInvite(phoneNumber, code);

      return { data: { groupJid: groupJid || null } };
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        code: t.String({
          description: "Group invite code",
          example: "ABC123xyz",
        }),
      }),
      detail: {
        description: "Join a group using an invite code",
        responses: {
          200: {
            description: "Joined group successfully",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        groupJid: { type: "string", nullable: true },
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
  .post(
    "/:phoneNumber/group-revoke-invite-v4",
    async ({ params, body }) => {
      const { phoneNumber } = params;
      const { groupJid: gJid, invitedJid } = body;

      const result = await baileys.groupRevokeInviteV4(
        phoneNumber,
        gJid,
        invitedJid,
      );

      return { data: { revoked: result } };
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        groupJid: groupJid(),
        invitedJid: userJid("JID of the invited user"),
      }),
      detail: {
        description: "Revoke a V4 invite for a specific user",
        responses: {
          200: {
            description: "V4 invite revoked successfully",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        revoked: { type: "boolean" },
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
  .post(
    "/:phoneNumber/group-accept-invite-v4",
    async ({ params, body }) => {
      const { phoneNumber } = params;
      const { key, inviteMessage } = body;

      const result = await baileys.groupAcceptInviteV4(
        phoneNumber,
        key,
        inviteMessage,
      );

      return { data: result };
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        key: t.Union([
          t.String({ description: "Invite key as string" }),
          iMessageKeyWithId,
        ]),
        inviteMessage: t.Object(
          {
            groupJid: groupJid("target group for the invite"),
            inviteCode: t.String({ description: "Invite code" }),
            inviteExpiration: t.Optional(t.Number()),
            groupName: t.Optional(t.String()),
            caption: t.Optional(t.String()),
          },
          {
            description: "Group invite message content",
          },
        ),
      }),
      detail: {
        description: "Accept a V4 group invite message",
        responses: {
          200: {
            description: "V4 invite accepted successfully",
          },
        },
      },
    },
  )
  .get(
    "/:phoneNumber/group-invite-info",
    async ({ params, query }) => {
      const { phoneNumber } = params;
      const { code } = query;

      return baileys.groupGetInviteInfo(phoneNumber, code);
    },
    {
      params: phoneNumberParams,
      query: t.Object({
        code: t.String({
          description: "Group invite code",
          example: "ABC123xyz",
        }),
      }),
      detail: {
        description:
          "Get group metadata from an invite code without joining the group",
        responses: {
          200: {
            description: "Group invite info retrieved successfully",
          },
        },
      },
    },
  )
  .post(
    "/:phoneNumber/group-toggle-ephemeral",
    async ({ params, body }) => {
      const { phoneNumber } = params;
      const { jid, ephemeralExpiration } = body;

      await baileys.groupToggleEphemeral(phoneNumber, jid, ephemeralExpiration);
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        jid: groupJid(),
        ephemeralExpiration: t.Number({
          description:
            "Duration in seconds for disappearing messages. Use 0 to disable.",
          minimum: 0,
          example: 604800,
        }),
      }),
      detail: {
        description: "Toggle disappearing messages for a group",
        responses: {
          200: {
            description: "Ephemeral setting updated successfully",
          },
        },
      },
    },
  )
  .post(
    "/:phoneNumber/group-setting-update",
    async ({ params, body }) => {
      const { phoneNumber } = params;
      const { jid, setting } = body;

      await baileys.groupSettingUpdate(phoneNumber, jid, setting);
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        jid: groupJid(),
        setting: t.Union(
          [
            t.Literal("announcement", { title: "announcement" }),
            t.Literal("not_announcement", { title: "not_announcement" }),
            t.Literal("locked", { title: "locked" }),
            t.Literal("unlocked", { title: "unlocked" }),
          ],
          {
            description:
              "Group setting to update. `announcement` makes only admins able to send messages. `not_announcement` allows all participants. `locked` makes only admins able to edit group info. `unlocked` allows all participants to edit.",
            example: "announcement",
          },
        ),
      }),
      detail: {
        description: "Update group settings (announcement/locked mode)",
        responses: {
          200: {
            description: "Group setting updated successfully",
          },
        },
      },
    },
  )
  .post(
    "/:phoneNumber/group-member-add-mode",
    async ({ params, body }) => {
      const { phoneNumber } = params;
      const { jid, mode } = body;

      await baileys.groupMemberAddMode(phoneNumber, jid, mode);
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        jid: groupJid(),
        mode: t.Union(
          [
            t.Literal("admin_add", { title: "admin_add" }),
            t.Literal("all_member_add", { title: "all_member_add" }),
          ],
          {
            description:
              "Who can add members. `admin_add` restricts to admins only. `all_member_add` allows all members.",
            example: "all_member_add",
          },
        ),
      }),
      detail: {
        description: "Set who can add members to the group",
        responses: {
          200: {
            description: "Member add mode updated successfully",
          },
        },
      },
    },
  )
  .post(
    "/:phoneNumber/group-join-approval-mode",
    async ({ params, body }) => {
      const { phoneNumber } = params;
      const { jid, mode } = body;

      await baileys.groupJoinApprovalMode(phoneNumber, jid, mode);
    },
    {
      params: phoneNumberParams,
      body: t.Object({
        jid: groupJid(),
        mode: t.Union(
          [
            t.Literal("on", { title: "on" }),
            t.Literal("off", { title: "off" }),
          ],
          {
            description:
              "Whether join requests require admin approval. `on` enables approval mode, `off` disables it.",
            example: "on",
          },
        ),
      }),
      detail: {
        description: "Toggle join approval mode for a group",
        responses: {
          200: {
            description: "Join approval mode updated successfully",
          },
        },
      },
    },
  )
  .get(
    "/:phoneNumber/group-fetch-all-participating",
    async ({ params }) => {
      const { phoneNumber } = params;

      return baileys.groupFetchAllParticipating(phoneNumber);
    },
    {
      params: phoneNumberParams,
      detail: {
        description:
          "Fetch metadata for all groups the connected number is participating in",
        responses: {
          200: {
            description: "All group metadata retrieved successfully",
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
        await coordinator.logoutWithLease(phoneNumber);
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
