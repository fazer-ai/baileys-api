import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import Elysia from "elysia";
import baileys from "@/baileys";
import config from "@/config";
import connectionsController from "./index";

// The send-message route maps a missing local socket to 404 (instead of a
// generic 500) so callers can tell "phone not connected" from a real failure.
describe("connectionsController send-message", () => {
  let prevEnv: typeof config.env;
  let prevRole: typeof config.cluster.role;

  beforeEach(() => {
    prevEnv = config.env;
    prevRole = config.cluster.role;
    // Dev mode bypasses the auth middleware, and standalone role skips the
    // worker 421 re-routing in onBeforeHandle.
    config.env = "development";
    config.cluster.role = "standalone";
  });

  afterEach(() => {
    config.env = prevEnv;
    config.cluster.role = prevRole;
  });

  const sendMessageRequest = (phone: string) =>
    new Request(`http://localhost/connections/${phone}/send-message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jid: "551101234567@s.whatsapp.net",
        messageContent: { text: "hello" },
      }),
    });

  it("returns 404 when the phone has no live connection", async () => {
    const app = new Elysia().use(connectionsController);

    // No connection registered for this phone, so the handler's getConnection
    // throws BaileysNotConnectedError on the real code path.
    const res = await app.handle(sendMessageRequest("+551234567890"));

    expect(res.status).toBe(404);
  });

  it("does not mask a generic send failure as 404", async () => {
    const spy = spyOn(baileys, "sendMessage").mockImplementation(async () => {
      throw new Error("unexpected boom");
    });

    try {
      const app = new Elysia().use(connectionsController);
      const res = await app.handle(sendMessageRequest("+551234567890"));

      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
  });
});

// Read-only restriction diagnostics: fetch the 463 reach-out time-lock state
// and the new-chat message cap without sending a message.
describe("connectionsController restriction diagnostics", () => {
  let prevEnv: typeof config.env;
  let prevRole: typeof config.cluster.role;

  beforeEach(() => {
    prevEnv = config.env;
    prevRole = config.cluster.role;
    config.env = "development";
    config.cluster.role = "standalone";
  });

  afterEach(() => {
    config.env = prevEnv;
    config.cluster.role = prevRole;
  });

  const getRequest = (phone: string, path: string) =>
    new Request(`http://localhost/connections/${phone}/${path}`, {
      method: "GET",
    });

  describe("GET /:phoneNumber/reachout-timelock", () => {
    it("returns 200 with the reach-out time-lock state", async () => {
      const spy = spyOn(baileys, "getReachoutTimelock").mockResolvedValue({
        isActive: true,
        enforcementType: "BIZ_QUALITY",
      } as any);

      try {
        const app = new Elysia().use(connectionsController);
        const res = await app.handle(
          getRequest("+551234567890", "reachout-timelock"),
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as { data: { isActive: boolean } };
        expect(body.data.isActive).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it("returns 404 when the phone has no live connection", async () => {
      // No connection registered, so getConnection throws on the real path.
      const app = new Elysia().use(connectionsController);
      const res = await app.handle(
        getRequest("+551234567890", "reachout-timelock"),
      );

      expect(res.status).toBe(404);
    });
  });

  describe("GET /:phoneNumber/new-chat-cap", () => {
    it("returns 200 with the new-chat message cap", async () => {
      const spy = spyOn(baileys, "getNewChatMessageCap").mockResolvedValue({
        total_quota: 100,
        used_quota: 10,
        capping_status: "NONE",
      } as any);

      try {
        const app = new Elysia().use(connectionsController);
        const res = await app.handle(
          getRequest("+551234567890", "new-chat-cap"),
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as { data: { total_quota: number } };
        expect(body.data.total_quota).toBe(100);
      } finally {
        spy.mockRestore();
      }
    });

    it("returns 404 when the phone has no live connection", async () => {
      const app = new Elysia().use(connectionsController);
      const res = await app.handle(getRequest("+551234567890", "new-chat-cap"));

      expect(res.status).toBe(404);
    });
  });
});
