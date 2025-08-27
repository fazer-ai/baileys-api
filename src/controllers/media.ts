import path from "node:path";
import { file } from "bun";
import Elysia, { t } from "elysia";
import { authMiddleware } from "@/middlewares/auth";

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
    async ({ params, set }) => {
      const { messageId } = params;

      const mediaPath = path.resolve(process.cwd(), "media", messageId);
      const mediaFile = file(mediaPath);
      if (await mediaFile.exists()) {
        set.headers["content-type"] = "application/octet-stream";
        set.headers["cache-control"] = "public, max-age=31536000";

        // FIXME: `stream()` is not working correctly right now, so we handle the headers manually.
        const buffer = await mediaFile.arrayBuffer();
        return new Response(buffer, {
          headers: {
            "content-type": "application/octet-stream",
            "cache-control": "public, max-age=31536000",
          },
        });
      }
      return new Response("File not found", { status: 404 });
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

export default mediaController;
