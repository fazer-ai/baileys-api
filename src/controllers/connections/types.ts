import { t } from "elysia";

export const jid = (moreInfo?: string) => {
  const description =
    moreInfo === undefined
      ? "Recipient whatsapp jid"
      : `Recipient whatsapp jid [${moreInfo}]`;
  return t.String({
    description: description,
    example: "551101234567@s.whatsapp.net",
  });
};

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

export const anyMessageContent = t.Union([
  t.Object({
    text: t.String({ description: "Text message", example: "Hello world!" }),
  }),
  t.Object({
    image: t.String({ description: "Base64 encoded image data" }),
    caption: t.Optional(t.String()),
    mimetype: t.Optional(t.String()),
  }),
  t.Object({
    video: t.String({ description: "Base64 encoded video data" }),
    caption: t.Optional(t.String()),
    mimetype: t.Optional(t.String()),
  }),
  t.Object({
    document: t.String({ description: "Base64 encoded document data" }),
    fileName: t.Optional(t.String()),
    mimetype: t.Optional(t.String()),
  }),
  t.Object({
    audio: t.String({ description: "Base64 encoded audio data" }),
    ptt: t.Optional(t.Boolean()),
    mimetype: t.Optional(t.String()),
  }),
  t.Object({
    react: t.Object({
      key: iMessageKey,
      text: t.String({
        description: "Emoji to react with",
        example: "👍",
      }),
    }),
  }),
]);

const lastMessageList = t.Array(
  t.Object({
    key: iMessageKey,
    messageTimestamp: t.Number(),
  }),
);

const chatLabelAssociationActionBody = t.Object({
  labelId: t.String(),
});

const messageLabelAssociationActionBody = t.Object({
  labelId: t.String(),
  messageId: t.String(),
});

export const chatModification = t.Union([
  t.Object({
    pushNameSetting: t.String(),
  }),
  t.Object({
    pin: t.Boolean(),
  }),
  t.Object({
    mute: t.Number(),
  }),
  t.Object({
    clear: t.Boolean(),
  }),
  t.Object({
    deleteForMe: t.Object({
      deleteMedia: t.Boolean(),
      key: iMessageKey,
      timestamp: t.Number(),
    }),
  }),
  t.Object({
    star: t.Object({
      messages: t.Array(
        t.Object({
          id: t.String(),
          fromMe: t.Optional(t.Boolean()),
        }),
      ),
      star: t.Boolean(),
    }),
  }),
  t.Object({
    markRead: t.Boolean(),
    lastMessages: lastMessageList,
  }),
  t.Object({
    delete: t.Literal(true),
    lastMessages: lastMessageList,
  }),
  t.Object({
    addLabel: t.Object({
      id: t.String(),
      name: t.Optional(t.String({ description: "Label name" })),
      color: t.Optional(t.Number({ description: "Label color ID" })),
      deleted: t.Optional(
        t.Boolean({ description: "Is label has been deleted" }),
      ),
      predefinedId: t.Optional(
        t.Number({
          description:
            "WhatsApp has 5 predefined labels (New customer, New order & etc)",
        }),
      ),
    }),
  }),
  t.Object({
    addChatLabel: chatLabelAssociationActionBody,
  }),
  t.Object({
    removeChatLabel: chatLabelAssociationActionBody,
  }),
  t.Object({
    addMessageLabel: messageLabelAssociationActionBody,
  }),
  t.Object({
    removeMessageLabel: messageLabelAssociationActionBody,
  }),
]);
