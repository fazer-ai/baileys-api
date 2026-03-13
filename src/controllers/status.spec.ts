import { beforeEach, describe, expect, it } from "bun:test";
import Elysia from "elysia";
import config from "@/config";
import statusController from "./status";

describe("statusController", () => {
  beforeEach(() => {
    config.env = "production";
  });

  it("GET /status returns sanitized config", async () => {
    const app = new Elysia().use(statusController);
    const res = await app.handle(new Request("http://localhost/status"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.env).toBeDefined();
    expect(body.baileys).toBeDefined();
    expect(body.redis).toBeDefined();
    // Password should be omitted
    expect(body.redis.password).toBe("********");
  });

  it("GET /status/auth requires authentication in production", async () => {
    const app = new Elysia().use(statusController);
    const res = await app.handle(new Request("http://localhost/status/auth"));
    expect(res.status).toBe(401);
  });

  it("GET /status/auth returns OK when authenticated", async () => {
    config.env = "development";
    const app = new Elysia().use(statusController);
    const res = await app.handle(new Request("http://localhost/status/auth"));
    expect(res.status).toBe(200);
  });
});
