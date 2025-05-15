import path from "node:path";
import logger from "@/lib/logger";
import { authMiddleware } from "@/middlewares/auth";
import { file } from "bun";
import Elysia, { t } from "elysia";

const mediaController = new Elysia({
  prefix: "/media",
  detail: {
    tags: ["Media"],
    security: [{ xApiKey: [] }],
  },
})
  .use(authMiddleware)
  .get(
    ":messageId",
    async ({ params }) => {
      const { messageId } = params;

      const mediaPath = path.resolve(process.cwd(), "media", messageId);
      const media = file(mediaPath);
      try {
        return await media.arrayBuffer();
      } catch (error) {
        logger.error("[ERROR] %s", error);
        return new Response("File not found", { status: 404 });
      }
    },
    {
      params: t.Object({
        messageId: t.String({
          description: "Message ID to download media from",
        }),
      }),
    },
  );

// biome-ignore lint/style/noDefaultExport: <explanation>
export default mediaController;
