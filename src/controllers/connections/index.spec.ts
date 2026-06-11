import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import Elysia from "elysia";
import baileys from "@/baileys";
import config from "@/config";
import connectionsController from "./index";

// The send-message route maps a missing local socket to 404 (instead of a
// generic 500) so callers can tell "phone not connected" from a real failure.
describe("connectionsController send-message", () => {
  beforeEach(() => {
    // Dev mode bypasses the auth middleware, and standalone role skips the
    // worker 421 re-routing in onBeforeHandle.
    config.env = "development";
    config.cluster.role = "standalone";
  });

  afterEach(() => {
    config.env = "production";
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
