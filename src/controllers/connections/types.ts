import { t } from "elysia";

export const phoneNumberParams = t.Object({
  phoneNumber: t.String({
    minLength: 13,
    maxLength: 14,
    description: "Phone number for connection",
  }),
});

const iMessageKey = t.Object({
  id: t.Optional(t.String()),
  remoteJid: t.Optional(t.String()),
  fromMe: t.Optional(t.Boolean()),
  participant: t.Optional(t.String()),
});

export const anyMessageContent = t.Union([
  t.Object({
    text: t.String(),
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
    mimetype: t.String(),
    fileName: t.Optional(t.String()),
  }),
  t.Object({
    audio: t.String({ description: "Base64 encoded audio data" }),
    mimetype: t.Optional(t.String()),
    ptt: t.Optional(t.Boolean()),
  }),
  t.Object({
    react: t.Object({
      key: iMessageKey,
      text: t.String(),
    }),
  }),
  t.Object({
    buttonReply: t.Object({
      displayText: t.String(),
      id: t.String(),
      index: t.Number(),
    }),
    type: t.Union([t.Literal("template"), t.Literal("plain")]),
  }),
  t.Object({
    listReply: t.Object({
      title: t.Optional(t.String()),
      listType: t.Optional(
        t.Enum({
          UNKNOWN: 0,
          SINGLE_SELECT: 1,
        }),
      ),
      singleSelectReply: t.Optional(
        t.Object({ selectedRowId: t.Optional(t.String()) }),
      ),
      description: t.Optional(t.String()),
    }),
  }),
]);
