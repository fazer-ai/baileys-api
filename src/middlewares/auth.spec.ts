import { beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
// We test the middleware logic via Elysia integration
import { Elysia } from "elysia";
import config from "@/config";
import redis from "@/lib/redis";
import {
  type AuthData,
  adminGuard,
  authMiddleware,
  clearApiKeyCache,
  REDIS_KEY_PREFIX,
} from "./auth";

// Access the mock string store through the shared preload mock
const mockRedisStore = (redis as any).__stringData as Map<string, string>;

function makeApp() {
  return new Elysia()
    .use(authMiddleware)
    .get("/test", ({ auth }) => ({ auth }));
}

function makeAdminApp() {
  return new Elysia().use(adminGuard).get("/admin", ({ auth }) => ({ auth }));
}

describe("authMiddleware", () => {
  beforeEach(() => {
    mockRedisStore.clear();
    config.env = "production";
  });

  it("returns 401 when no API key is provided in production", async () => {
    const app = makeApp();
    const res = await app.handle(new Request("http://localhost/test"));
    expect(res.status).toBe(401);
  });

  it("allows requests without API key in development mode", async () => {
    config.env = "development";
    const app = makeApp();
    const res = await app.handle(new Request("http://localhost/test"));
    expect(res.status).toBe(200);
  });

  it("returns 401 for invalid API key", async () => {
    const app = makeApp();
    const res = await app.handle(
      new Request("http://localhost/test", {
        headers: { "x-api-key": "invalid-key" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("authenticates with a valid API key", async () => {
    const apiKey = "valid-api-key";
    const authData: AuthData = { role: "user" };
    mockRedisStore.set(
      `${REDIS_KEY_PREFIX}:${apiKey}`,
      JSON.stringify(authData),
    );

    // Clear cache to force Redis lookup
    clearApiKeyCache(apiKey);

    const app = makeApp();
    const res = await app.handle(
      new Request("http://localhost/test", {
        headers: { "x-api-key": apiKey },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.auth.role).toBe("user");
  });

  it("caches API key lookups", async () => {
    const apiKey = "cached-key";
    const authData: AuthData = { role: "user" };
    mockRedisStore.set(
      `${REDIS_KEY_PREFIX}:${apiKey}`,
      JSON.stringify(authData),
    );
    clearApiKeyCache(apiKey);

    const app = makeApp();

    // First request populates cache
    await app.handle(
      new Request("http://localhost/test", {
        headers: { "x-api-key": apiKey },
      }),
    );

    // Remove from Redis - cache should still work
    mockRedisStore.delete(`${REDIS_KEY_PREFIX}:${apiKey}`);

    const res = await app.handle(
      new Request("http://localhost/test", {
        headers: { "x-api-key": apiKey },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("provides apiKeyHash in the context", async () => {
    const apiKey = "hash-test-key";
    const authData: AuthData = { role: "user" };
    mockRedisStore.set(
      `${REDIS_KEY_PREFIX}:${apiKey}`,
      JSON.stringify(authData),
    );
    clearApiKeyCache(apiKey);

    const expectedHash = createHash("sha256").update(apiKey).digest("hex");

    const app = new Elysia()
      .use(authMiddleware)
      .get("/test", ({ apiKeyHash }) => ({ apiKeyHash }));

    const res = await app.handle(
      new Request("http://localhost/test", {
        headers: { "x-api-key": apiKey },
      }),
    );
    const body = await res.json();
    expect(body.apiKeyHash).toBe(expectedHash);
  });
});

describe("adminGuard", () => {
  beforeEach(() => {
    mockRedisStore.clear();
    config.env = "production";
  });

  it("returns 404 for non-admin users", async () => {
    const apiKey = "user-key";
    const authData: AuthData = { role: "user" };
    mockRedisStore.set(
      `${REDIS_KEY_PREFIX}:${apiKey}`,
      JSON.stringify(authData),
    );
    clearApiKeyCache(apiKey);

    const app = makeAdminApp();
    const res = await app.handle(
      new Request("http://localhost/admin", {
        headers: { "x-api-key": apiKey },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("allows admin users", async () => {
    const apiKey = "admin-key";
    const authData: AuthData = { role: "admin" };
    mockRedisStore.set(
      `${REDIS_KEY_PREFIX}:${apiKey}`,
      JSON.stringify(authData),
    );
    clearApiKeyCache(apiKey);

    const app = makeAdminApp();
    const res = await app.handle(
      new Request("http://localhost/admin", {
        headers: { "x-api-key": apiKey },
      }),
    );
    expect(res.status).toBe(200);
  });
});
