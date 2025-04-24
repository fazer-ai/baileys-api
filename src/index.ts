import baileys from "@/baileys";
import config from "@/config";
import adminController from "@/controllers/admin";
import connectionsController from "@/controllers/connections";
import statusController from "@/controllers/status";
import logger, { deepSanitizeObject } from "@/lib/logger";
import { initializeRedis } from "@/lib/redis";
import swagger from "@elysiajs/swagger";
import { Elysia } from "elysia";

const app = new Elysia()
  .onAfterResponse(({ request, response, set }) => {
    logger.info(
      "%s %s body=%o [%s] %o",
      request.method,
      request.url,
      request.body ?? {},
      set.status,
      response ?? {},
    );
  })
  .onError(({ path, error, code }) => {
    logger.error("%s\n%s", path, (error as Error).stack);
    switch (code) {
      case "INTERNAL_SERVER_ERROR": {
        const message =
          config.env === "development" ? error.stack : "Something went wrong";
        logger.error("%s\n%s", path, error.stack);
        return new Response(message, { status: 500 });
      }
      default:
    }
  })
  .use(
    swagger({
      documentation: {
        info: {
          title: config.packageInfo.name,
          version: config.packageInfo.version,
        },
        tags: [
          {
            name: "Status",
            description: "Fetch server status",
          },
          {
            name: "Connections",
            description: "Manage connections",
          },
          {
            name: "Admin",
            description: "Admin operations",
          },
        ],
        components: {
          securitySchemes: {
            xApiKey: {
              type: "apiKey",
              in: "header",
              name: "x-api-key",
              description: "API key. See scripts/manage-api-keys.ts",
            },
          },
        },
      },
    }),
  )
  .use(statusController)
  .use(adminController)
  .use(connectionsController)
  .listen(config.port);

logger.info(
  `${config.packageInfo.name}@${config.packageInfo.version} running on ${app.server?.hostname}:${app.server?.port}`,
);
logger.info(
  "Loaded config %s",
  JSON.stringify(
    deepSanitizeObject(config, { omitKeys: ["password"] }),
    null,
    2,
  ),
);

initializeRedis().then(() =>
  baileys.reconnectFromAuthStore().catch((e) => {
    logger.error("Failed to reconnect from auth store: %s", e.stack);
  }),
);
