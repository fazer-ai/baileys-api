import { t } from "elysia";

const tWAMessageKey = t.Object({
  remoteJid: t.Optional(t.Union([t.String(), t.Null()])),
  fromMe: t.Optional(t.Union([t.String(), t.Null()])),
  id: t.Optional(t.Union([t.String(), t.Null()])),
  participant: t.Optional(t.Union([t.String(), t.Null()])),
});

const tAnyMessageContent = () =>
  t.Union([
    t.Object({
      text: t.String(),
      linkPreview: t.Optional(
        t.Object({
          "canonical-url": t.String(),
          title: t.String(),
          description: t.Optional(t.String()),
        }),
      ),
      mentions: t.Optional(
        t.Array(t.String(), {
          description:
            "List of JIDs that are mentioned in the accompanying text",
        }),
      ),
      edit: t.Optional(t.Object(tWAMessageKey)),
      viewOnce: t.Optional(t.Boolean()),
    }),
    t.Object({
      image: t.String(),
      caption: t.Optional(t.String()),
      mentions: t.Optional(t.Array(t.String())),
      mimetype: t.Optional(t.String()),
      edit: t.Optional(t.Object(tWAMessageKey)),
      viewOnce: t.Optional(t.Boolean()),
    }),
    t.Object({
      video: t.String(),
      caption: t.Optional(t.String()),
      gifPlayback: t.Optional(t.Boolean()),
      ptv: t.Optional(t.Boolean()),
      mentions: t.Optional(t.Array(t.String())),
      mimetype: t.Optional(t.String()),
      edit: t.Optional(t.Object(tWAMessageKey)),
      viewOnce: t.Optional(t.Boolean()),
    }),
    t.Object({
      document: t.String(),
      mimetype: t.Optional(t.String()),
      fileName: t.Optional(t.String()),
      edit: t.Optional(t.Object(tWAMessageKey)),
      viewOnce: t.Optional(t.Boolean()),
    }),
    t.Object({
      audio: t.String(),
      ptt: t.Optional(t.Boolean()),
      mimetype: t.Optional(t.String()),
      edit: t.Optional(t.Object(tWAMessageKey)),
      viewOnce: t.Optional(t.Boolean()),
    }),
    t.Object({
      sticker: t.String(),
      isAnimated: t.Optional(t.Boolean()),
      edit: t.Optional(t.Object(tWAMessageKey)),
      viewOnce: t.Optional(t.Boolean()),
    }),
    t.Object({ delete: tWAMessageKey }),
    t.Object({
      disappearingMessagesInChat: t.Union([t.Boolean(), t.Number()]),
    }),
  ]);

const tMiscMessageGenerationOptions = () =>
  t.Object({
    messageId: t.Optional(t.String()),
    useCachedGroupMetadata: t.Optional(t.Boolean()),
    quoted: t.Optional(t.Object(tWAMessageKey)),
    ephemeralExpiration: t.Optional(t.Union([t.Number(), t.String()])),
    statusJidList: t.Optional(t.Array(t.String())),
    backgroundColor: t.Optional(t.String()),
    font: t.Optional(t.String()),
    broadcast: t.Optional(t.Boolean()),
  });

export const T = {
  AnyMessageContent: tAnyMessageContent,
  MiscMessageGenerationOptions: tMiscMessageGenerationOptions,
};
