import { getMediaBuffer } from "@/baileys/helpers/downloadMediaFromMessages";
import { authMiddleware } from "@/middlewares/auth";
import Elysia, { t } from "elysia";
import { downloadableMessage, mediaType } from "./types";
import { mediaDownloadOptions } from "./types";

const mediaController = new Elysia({
  prefix: "/media",
  detail: {
    tags: ["Media"],
    security: [{ xApiKey: [] }],
  },
})
  .use(authMiddleware)
  .post(
    "/download",
    async ({ body }) => {
      const { mediaMessage, type, opts } = body;
      return await getMediaBuffer(mediaMessage, type, opts);
    },
    {
      body: t.Object({
        mediaMessage: downloadableMessage,
        type: mediaType,
        opts: t.Optional(mediaDownloadOptions),
      }),
    },
  );

// biome-ignore lint/style/noDefaultExport: <explanation>
export default mediaController;
