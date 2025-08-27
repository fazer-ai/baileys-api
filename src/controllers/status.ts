import Elysia from "elysia";
import config from "@/config";
import { deepSanitizeObject } from "@/lib/logger";
import { authMiddleware } from "@/middlewares/auth";

const statusController = new Elysia({
  prefix: "/status",
  detail: {
    tags: ["Status"],
    security: [{ xApiKey: [] }],
  },
})
  .get("", () => deepSanitizeObject(config, { omitKeys: ["password"] }), {
    detail: {
      responses: {
        200: {
          description: "Server running",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  packageInfo: {
                    type: "object",
                    properties: {
                      name: { type: "string", example: "baileys-api" },
                      version: { type: "string", example: "1.0.0" },
                      description: { type: "string" },
                      repository: {
                        type: "object",
                        properties: {
                          type: { type: "string", example: "git" },
                          url: {
                            type: "string",
                            example:
                              "https://github.com/fazer-ai/baileys-api.git",
                          },
                        },
                      },
                    },
                  },
                  port: {
                    type: "number",
                    example: 3025,
                  },
                  env: {
                    type: "string",
                    enum: ["development", "production"],
                    example: "development",
                  },
                  logLevel: {
                    type: "string",
                    example: "info",
                  },
                  baileys: {
                    type: "object",
                    properties: {
                      logLevel: { type: "string", example: "warn" },
                      clientVersion: { type: "string", example: "default" },
                      ignoreGroupMessages: { type: "boolean", example: true },
                      ignoreStatusMessages: { type: "boolean", example: true },
                      ignoreBroadcastMessages: {
                        type: "boolean",
                        example: true,
                      },
                      ignoreNewsletterMessages: {
                        type: "boolean",
                        example: true,
                      },
                      ignoreBotMessages: { type: "boolean", example: true },
                      ignoreMetaAiMessages: { type: "boolean", example: true },
                    },
                  },
                  redis: {
                    type: "object",
                    properties: {
                      url: {
                        type: "string",
                        example: "redis://localhost:6379",
                      },
                      password: {
                        type: "string",
                        example: "********",
                        description: "Omitted password",
                      },
                    },
                  },
                  webhook: {
                    type: "object",
                    properties: {
                      retryPolicy: {
                        type: "object",
                        properties: {
                          maxRetries: { type: "number", example: 3 },
                          retryInterval: { type: "number", example: 5000 },
                          backoffFactor: { type: "number", example: 3 },
                        },
                      },
                    },
                  },
                  corsOrigin: {
                    type: "string",
                    example: "localhost",
                  },
                  keyStore: {
                    type: "object",
                    properties: {
                      lruCacheMax: { type: "number", example: 100 },
                      lruCacheTtl: { type: "number", example: 600000 },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  })
  .use(authMiddleware)
  .get("/auth", () => "OK", {
    detail: {
      responses: {
        200: {
          description: "Authenticated",
        },
      },
    },
  });

export default statusController;
