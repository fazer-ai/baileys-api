import { t } from "elysia";

export const phoneNumberParams = t.Object({
  phoneNumber: t.String({
    minLength: 13,
    maxLength: 14,
    description: "Phone number for connection",
  }),
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
  }),
]);
