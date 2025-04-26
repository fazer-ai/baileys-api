import config from "@/config";
import logger from "@/lib/logger";
import redis from "@/lib/redis";
import type { Elysia } from "elysia";

export interface AuthData {
  role: "user" | "admin";
}

export const REDIS_KEY_PREFIX = "@baileys-api:api-keys";

function getApiKey(headers: Headers): string | null {
  return headers.get("x-api-key");
}

export const authMiddleware = (app: Elysia) =>
  app
    .derive(async ({ request }) => {
      const apiKey = getApiKey(request.headers);
      if (!apiKey) {
        return { auth: null };
      }

      try {
        const key = `${REDIS_KEY_PREFIX}:${apiKey}`;
        const raw = await redis.get(key);

        if (!raw) {
          logger.warn("Invalid API key attempted: %s", apiKey);
          return { auth: null };
        }

        const auth = JSON.parse(raw) as AuthData;
        return { auth };
      } catch (error) {
        logger.error("Auth middleware error %o", error);
        return { auth: null };
      }
    })
    .onBeforeHandle(({ auth, set }) => {
      if (config.env === "development") {
        return;
      }

      if (!auth) {
        set.status = 401;
        return {
          error: "Unauthorized",
          message: "Valid API key required",
        };
      }
    });

export const adminGuard = (app: Elysia) =>
  app.use(authMiddleware).onBeforeHandle(({ auth, set }) => {
    if (auth?.role !== "admin") {
      set.status = 404;
      return "NOT_FOUND";
    }
  });
