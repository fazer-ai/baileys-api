import { t } from "elysia";

// Base64-encoded binary field. importSession.ts decodes these via
// Buffer.from(..., "base64"); validating the shape at the schema turns
// malformed input into a clear 422 instead of silently corrupted creds that
// only surface later as a failed handshake. The pattern enforces canonical
// base64: non-empty, length a multiple of 4, with correct `=` padding only in
// the final quad — not just an allowed-character check.
const base64String = (description?: string) =>
  t.String({
    pattern:
      "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$",
    ...(description ? { description } : {}),
  });

export const userJid = (moreInfo?: string) =>
  t.String({
    description: `User JID${moreInfo ? ` [${moreInfo}]` : ""}`,
    example: "551101234567@s.whatsapp.net",
  });

export const groupJid = (moreInfo?: string) =>
  t.String({
    description: `Group JID${moreInfo ? ` [${moreInfo}]` : ""}`,
    example: "123456789012345678@g.us",
  });

export const anyJid = (moreInfo?: string) =>
  t.String({
    description: `WhatsApp JID${moreInfo ? ` [${moreInfo}]` : ""}`,
    examples: ["551101234567@s.whatsapp.net", "123456789012345678@g.us"],
  });

export const phoneNumberParams = t.Object({
  phoneNumber: t.String({
    minLength: 6,
    maxLength: 16,
    pattern: "^\\+\\d{5,15}$",
    description: "Phone number for connection. Must have + prefix.",
    example: "+551234567890",
  }),
});

// Session extracted from an already-linked WhatsApp Web tab by the browser
// extension. All binary fields are base64 strings. Optional fields must be
// omitted when absent (not sent as null). Mirrors ExtractedSession in
// src/baileys/importSession.ts.
export const extractedSession = t.Object(
  {
    noiseCandidates: t.Array(
      t.Object({ private: base64String(), public: base64String() }),
      {
        minItems: 1,
        // Bounded like the other array bodies in this controller: the list is
        // persisted to Redis and iterated during candidate cycling, so an
        // unbounded array is needless load. The extractor yields a handful.
        maxItems: 20,
        description:
          "Noise keypair candidates (base64). Only one is the real pair; the server cycles them until the socket opens.",
      },
    ),
    identityKey: t.Object({
      private: base64String(),
      public: base64String(),
    }),
    registrationId: t.Number(),
    advSecretKey: base64String("ADV secret key (base64)"),
    account: t.Object({
      details: base64String(),
      accountSignatureKey: base64String(),
      accountSignature: base64String(),
      deviceSignature: base64String(),
    }),
    id: t.String({
      description: "Companion device JID",
      example: "551101234567:12@s.whatsapp.net",
    }),
    lid: t.Optional(t.String()),
    platform: t.Optional(t.String()),
    signedPreKey: t.Optional(
      t.Object({
        keyId: t.Number(),
        private: base64String(),
        public: base64String(),
        signature: base64String(),
      }),
    ),
    pushName: t.Optional(t.String()),
    routingInfo: t.Optional(base64String()),
  },
  {
    description:
      "Impersonation credentials — never log this object. Transported over HTTPS only.",
  },
);

// Shared connection-options request fields. Spread into both POST /:phoneNumber
// and POST /:phoneNumber/import-session so the two bodies cannot drift apart as
// options are added or their descriptions/defaults change.
export const connectionOptionsSchema = {
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
  groupsEnabled: t.Optional(
    t.Boolean({
      description:
        "Enable full group message processing. When false, group messages are accumulated and sent as activity summaries.",
      default: true,
    }),
  ),
  autoPresenceSubscribe: t.Optional(
    t.Boolean({
      description:
        "Automatically subscribe to presence updates when sending/receiving messages or typing status to/from a contact. Subscriptions are ephemeral and re-established automatically.",
      default: false,
    }),
  ),
} as const;

export const iMessageKey = t.Object({
  id: t.Optional(t.String()),
  remoteJid: t.Optional(t.String()),
  fromMe: t.Optional(t.Boolean()),
  participant: t.Optional(t.String()),
});

export const iMessageKeyWithId = t.Object({
  id: t.String({ description: "Message ID" }),
  remoteJid: t.Optional(t.String()),
  fromMe: t.Optional(t.Boolean()),
  participant: t.Optional(t.String()),
});

export const quotedMessage = t.Object(
  {
    key: iMessageKeyWithId,
    message: t.Record(t.String(), t.Unknown(), {
      description:
        "Original message content. This is required for the quoted message preview to appear correctly. Use the message object from the original messages.upsert webhook payload.",
      example: { conversation: "Hello!" },
    }),
  },
  {
    description:
      "Message to reply to. Both key and message are required for the quoted message preview to appear correctly.",
  },
);

export const anyMessageContent = t.Union([
  t.Object(
    {
      text: t.String({ description: "Text message", example: "Hello world!" }),
      mentions: t.Optional(
        t.Array(userJid("user to mention in group message")),
      ),
      quotedMessage: t.Optional(quotedMessage),
    },
    {
      title: "Text message",
    },
  ),
  t.Object(
    {
      image: t.String({ description: "Base64 encoded image data" }),
      caption: t.Optional(t.String()),
      mimetype: t.Optional(t.String()),
      quotedMessage: t.Optional(quotedMessage),
    },
    {
      title: "Image message",
    },
  ),
  t.Object(
    {
      video: t.String({ description: "Base64 encoded video data" }),
      caption: t.Optional(t.String()),
      mimetype: t.Optional(t.String()),
      quotedMessage: t.Optional(quotedMessage),
    },
    {
      title: "Video message",
    },
  ),
  t.Object(
    {
      document: t.String({ description: "Base64 encoded document data" }),
      fileName: t.Optional(t.String()),
      mimetype: t.Optional(t.String()),
      caption: t.Optional(t.String()),
      quotedMessage: t.Optional(quotedMessage),
    },
    {
      title: "Document message",
    },
  ),
  t.Object(
    {
      audio: t.String({ description: "Base64 encoded audio data" }),
      ptt: t.Optional(t.Boolean()),
      mimetype: t.Optional(t.String()),
      quotedMessage: t.Optional(quotedMessage),
    },
    {
      title: "Audio message",
    },
  ),
  t.Object(
    {
      react: t.Object({
        key: iMessageKey,
        text: t.String({
          description: "Emoji to react with",
          example: "👍",
        }),
      }),
    },
    {
      title: "Reaction message",
    },
  ),
]);

export const editableMessageContent = t.Object(
  {
    text: t.String({
      description: "New text content for the message",
      example: "Updated message text",
    }),
    mentions: t.Optional(t.Array(userJid("user to mention in group message"))),
  },
  {
    title: "Editable text message",
    description:
      "Message content that can be edited. Only text messages can be edited on WhatsApp.",
  },
);

const lastMessageList = t.Array(
  t.Object({
    key: iMessageKey,
    messageTimestamp: t.Number(),
  }),
);

export const chatModification = t.Object(
  {
    markRead: t.Boolean(),
    lastMessages: lastMessageList,
  },
  {
    title: "Mark read/unread",
  },
);
