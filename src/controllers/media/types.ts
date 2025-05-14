import { t } from "elysia";

export const downloadableMessage = t.Object({
  mediaKey: t.Optional(t.Uint8Array()),
  directPath: t.Optional(t.String()),
  url: t.Optional(t.String()),
});

export const mediaType = t.Union([
  t.Literal("image"),
  t.Literal("video"),
  t.Literal("audio"),
  t.Literal("document"),
  t.Literal("sticker"),
]);

export const mediaDownloadOptions = t.Object({
  startByte: t.Number(),
  endByte: t.Number(),
});
