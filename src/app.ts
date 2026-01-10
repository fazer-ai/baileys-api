// @ts-expect-error
import cors from "@elysiajs/cors";
// @ts-expect-error
import swagger from "@elysiajs/swagger";
import Elysia from "elysia";
import { BaileysNotConnectedError } from "@/baileys/connection"; // Importar o erro
import config from "@/config";
import adminController from "@/controllers/admin";
import connectionsController from "@/controllers/connections";
import groupsController from "@/controllers/groups";
import mediaController from "@/controllers/media";
import statusController from "@/controllers/status";
import { errorToString } from "@/helpers/errorToString";
import logger from "@/lib/logger";

const app = new Elysia()
  // ...
  .onError(({ path, error, code }: { path: string; error: unknown; code: string }) => {
    logger.error("%s\n%s", path, errorToString(error));

    if (error instanceof BaileysNotConnectedError) {
      return new Response("Phone number not connected", { status: 404 });
    }

    switch (code) {
      case "INTERNAL_SERVER_ERROR": {
        // Expose error in production for debugging
        return new Response(errorToString(error), { status: 500 });
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
          description: `${config.packageInfo.description} [See on GitHub](${config.packageInfo.repository.url})`,
        },
        servers: [
          {
            url: `http://localhost:${config.port}`,
            description: "Local development server",
          },
          {
            url: "{scheme}://{customUrl}",
            description: "Custom server",
            variables: {
              scheme: {
                enum: ["http", "https"],
                default: "https",
                description: "HTTP or HTTPS",
              },
              customUrl: {
                default: "your-domain.com",
                description: "Your API domain (without protocol)",
              },
            },
          },
        ],
        tags: [
          {
            name: "Status",
            description: "Fetch server status",
          },
          {
            name: "Connections",
            description: "WhatsApp connections operations",
          },
          {
            name: "Admin",
            description: "Admin operations",
          },
          {
            name: "Groups",
            description: "Group management operations",
          },
          {
            name: "Media",
            description: "Retrieve media content from a message",
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
  .use(groupsController)
  .use(mediaController);

if (config.env === "development") {
  app.use(cors());
} else {
  app.use(cors({ origin: config.corsOrigin }));
}

export default app;
