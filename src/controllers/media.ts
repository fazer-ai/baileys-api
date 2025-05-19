import path from "node:path";
import logger from "@/lib/logger";
import { authMiddleware } from "@/middlewares/auth";
import { file } from "bun";
import Elysia, { t } from "elysia";

const mediaController = new Elysia({
  prefix: "/media",
  detail: {
    tags: ["Media"],
    description: "Media file download",
    security: [{ xApiKey: [] }],
  },
})
  // TODO: Use auth data to limit access to existing connections.
  .use(authMiddleware)
  .get(
    ":messageId",
    async ({ params }) => {
      const { messageId } = params;

      const mediaPath = path.resolve(process.cwd(), "media", messageId);
      const media = file(mediaPath);
      try {
        return await media.stream();
      } catch (error) {
        logger.error("[ERROR] %s", error);
        return new Response("File not found", { status: 404 });
      }
    },
    {
      params: t.Object({
        messageId: t.String({
          description: "Message ID to download media from",
          // NOTE: From empirical testing, most message IDs are below 33 characters.
          // To avoid any issues, we set the max length to 64 characters.
          pattern: "^[A-Z0-9]{1,64}$",
        }),
      }),
      detail: {
        responses: {
          200: {
            description: "Media file",
          },
          404: {
            description: "File not found",
          },
        },
      },
    },
  );

// biome-ignore lint/style/noDefaultExport: <explanation>
export default mediaController;
