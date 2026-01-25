import { t } from "elysia";

export const jid = (moreInfo?: string) =>
  t.String({
    description: `Recipient whatsapp jid${moreInfo ? ` [${moreInfo}]` : ""}`,
    example: "551101234567@s.whatsapp.net",
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
      mentions: t.Optional(t.Array(jid("user to mention in group message"))),
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
    mentions: t.Optional(t.Array(jid("user to mention in group message"))),
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
