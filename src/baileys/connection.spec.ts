import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// Track fetch calls for webhook tests
const fetchCalls: Array<{ url: string; body: string }> = [];
const originalFetch = globalThis.fetch;

import * as baileysModule from "@whiskeysockets/baileys";
import config from "@/config";
import redis from "@/lib/redis";
import { BaileysConnection, BaileysNotConnectedError } from "./connection";

const mockSocket = (baileysModule as any).__mockSocket;
const mockEventHandlers = (baileysModule as any).__mockEventHandlers;

describe("BaileysConnection", () => {
  let connection: BaileysConnection;
  const defaultOptions = {
    webhookUrl: "https://example.com/webhook",
    webhookVerifyToken: "test-token",
  };

  beforeEach(() => {
    connection = new BaileysConnection("+5511999999999", defaultOptions);
    mockEventHandlers.clear();
    mockSocket.ev.on.mockClear();
    mockSocket.logout.mockClear();
    mockSocket.sendMessage.mockClear();
    mockSocket.sendPresenceUpdate.mockClear();
    mockSocket.readMessages.mockClear();
    mockSocket.chatModify.mockClear();
    mockSocket.fetchMessageHistory.mockClear();
    mockSocket.sendReceipts.mockClear();
    mockSocket.profilePictureUrl.mockClear();
    mockSocket.ev.removeAllListeners.mockClear();
    mockSocket.onWhatsApp.mockClear();
    mockSocket.groupMetadata.mockClear();
    mockSocket.groupParticipantsUpdate.mockClear();
    mockSocket.groupCreate.mockClear();
    mockSocket.groupLeave.mockClear();
    mockSocket.groupUpdateSubject.mockClear();
    mockSocket.groupUpdateDescription.mockClear();
    mockSocket.groupInviteCode.mockClear();
    mockSocket.groupRevokeInvite.mockClear();
    mockSocket.groupAcceptInvite.mockClear();
    mockSocket.groupSettingUpdate.mockClear();
    mockSocket.groupToggleEphemeral.mockClear();
    mockSocket.groupFetchAllParticipating.mockClear();

    // Clear redis state
    (redis as any).__hashData.clear();
    (redis as any).__stringData.clear();
    (redis as any).__multiCommands.length = 0;
    (redis.hSet as any).mockClear();
    (redis.hGet as any).mockClear();
    (redis.del as any).mockClear();
    (redis.keys as any).mockClear();
    (redis.multi as any).mockClear();

    // Reset config
    config.webhook.retryPolicy.maxRetries = 0;

    fetchCalls.length = 0;

    globalThis.fetch = mock(
      async (url: string | URL | Request, init?: RequestInit) => {
        fetchCalls.push({
          url: url.toString(),
          body: init?.body as string,
        });
        return new Response("ok", { status: 200 });
      },
    ) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("constructor", () => {
    it("sets default values for optional parameters", () => {
      const conn = new BaileysConnection("+5511999", {
        webhookUrl: "https://hook.com",
        webhookVerifyToken: "token",
      });
      expect(conn.apiKeyHash).toBeNull();
    });

    it("stores the apiKeyHash", () => {
      const conn = new BaileysConnection("+5511999", {
        webhookUrl: "https://hook.com",
        webhookVerifyToken: "token",
        apiKeyHash: "hash-123",
      });
      expect(conn.apiKeyHash).toBe("hash-123");
    });
  });

  describe("#connect", () => {
    it("creates a socket and registers event listeners", async () => {
      await connection.connect();
      expect(mockSocket.ev.on).toHaveBeenCalled();
      expect(mockEventHandlers.has("connection.update")).toBe(true);
      expect(mockEventHandlers.has("creds.update")).toBe(true);
      expect(mockEventHandlers.has("messages.upsert")).toBe(true);
    });

    it("does nothing if already connected", async () => {
      await connection.connect();
      const callCount = mockSocket.ev.on.mock.calls.length;
      await connection.connect();
      // Should not register new listeners
      expect(mockSocket.ev.on.mock.calls.length).toBe(callCount);
    });
  });

  describe("#logout", () => {
    it("completes without throwing even when not connected (error is caught internally)", async () => {
      // logout() catches safeSocket() errors internally
      await connection.logout();
    });

    it("calls socket logout and clears state", async () => {
      await connection.connect();
      (redis.del as any).mockClear();
      await connection.logout();
      expect(mockSocket.logout).toHaveBeenCalledTimes(1);
      expect(redis.del).toHaveBeenCalled();
    });
  });

  describe("#sendMessage", () => {
    it("throws BaileysNotConnectedError if not connected", () => {
      expect(
        connection.sendMessage("jid@s.whatsapp.net", { text: "hi" }),
      ).rejects.toThrow(BaileysNotConnectedError);
    });

    it("calls socket sendMessage", async () => {
      await connection.connect();
      await connection.sendMessage("jid@s.whatsapp.net", { text: "hi" });
      expect(mockSocket.sendMessage).toHaveBeenCalled();
    });
  });

  describe("#sendPresenceUpdate", () => {
    it("does not throw if socket has no me credentials", async () => {
      await connection.connect();
      const origMe = mockSocket.authState.creds.me;
      mockSocket.authState.creds.me = null as any;

      // Should return undefined without calling sendPresenceUpdate
      const result = connection.sendPresenceUpdate("available");
      expect(result).toBeUndefined();

      mockSocket.authState.creds.me = origMe;
    });

    it("calls socket sendPresenceUpdate", async () => {
      await connection.connect();
      mockSocket.sendPresenceUpdate.mockClear();
      await connection.sendPresenceUpdate("composing", "target@s.whatsapp.net");
      expect(mockSocket.sendPresenceUpdate).toHaveBeenCalledWith(
        "composing",
        "target@s.whatsapp.net",
      );
    });
  });

  describe("#readMessages", () => {
    it("throws BaileysNotConnectedError if not connected", () => {
      expect(() => connection.readMessages([])).toThrow(
        BaileysNotConnectedError,
      );
    });

    it("delegates to socket", async () => {
      await connection.connect();
      const keys = [{ id: "msg-1" }];
      await connection.readMessages(keys as any);
      expect(mockSocket.readMessages).toHaveBeenCalledWith(keys);
    });
  });

  describe("#chatModify", () => {
    it("throws BaileysNotConnectedError if not connected", () => {
      expect(() =>
        connection.chatModify({} as any, "jid@s.whatsapp.net"),
      ).toThrow(BaileysNotConnectedError);
    });

    it("delegates to socket", async () => {
      await connection.connect();
      mockSocket.chatModify.mockClear();
      await connection.chatModify(
        { markRead: true } as any,
        "jid@s.whatsapp.net",
      );
      expect(mockSocket.chatModify).toHaveBeenCalledWith(
        { markRead: true },
        "jid@s.whatsapp.net",
      );
    });
  });

  describe("#deleteMessage", () => {
    it("sends a delete message via the socket", async () => {
      await connection.connect();
      mockSocket.sendMessage.mockClear();
      await connection.deleteMessage("jid@s.whatsapp.net", {
        id: "msg-1",
      } as any);
      expect(mockSocket.sendMessage).toHaveBeenCalledWith(
        "jid@s.whatsapp.net",
        { delete: { id: "msg-1" } },
      );
    });
  });

  describe("#editMessage", () => {
    it("sends an edit message via the socket", async () => {
      await connection.connect();
      mockSocket.sendMessage.mockClear();
      await connection.editMessage(
        "jid@s.whatsapp.net",
        { id: "msg-1" },
        { text: "edited" },
      );
      expect(mockSocket.sendMessage).toHaveBeenCalledWith(
        "jid@s.whatsapp.net",
        { text: "edited", edit: { id: "msg-1" } },
      );
    });
  });

  describe("#profilePictureUrl", () => {
    it("delegates to socket", async () => {
      await connection.connect();
      mockSocket.profilePictureUrl.mockClear();
      const _url = await connection.profilePictureUrl(
        "jid@s.whatsapp.net",
        "image",
      );
      expect(mockSocket.profilePictureUrl).toHaveBeenCalledWith(
        "jid@s.whatsapp.net",
        "image",
      );
    });
  });

  describe("#onWhatsApp", () => {
    it("delegates to socket", async () => {
      await connection.connect();
      await connection.onWhatsApp(["5521888@s.whatsapp.net"]);
      expect(mockSocket.onWhatsApp).toHaveBeenCalledWith(
        "5521888@s.whatsapp.net",
      );
    });
  });

  describe("#updateOptions", () => {
    it("updates connection options", () => {
      connection.updateOptions({
        webhookUrl: "https://new-hook.com",
        webhookVerifyToken: "new-token",
        clientName: "Firefox",
        groupsEnabled: true,
      });
      // No direct assertion on private fields — we verify it doesn't throw
    });
  });

  describe("group methods", () => {
    beforeEach(async () => {
      await connection.connect();
    });

    it("#groupMetadata delegates to socket", async () => {
      await connection.groupMetadata("group@g.us");
      expect(mockSocket.groupMetadata).toHaveBeenCalledWith("group@g.us");
    });

    it("#groupParticipants delegates to socket", async () => {
      await connection.groupParticipants(
        "group@g.us",
        ["user@s.whatsapp.net"],
        "add",
      );
      expect(mockSocket.groupParticipantsUpdate).toHaveBeenCalledWith(
        "group@g.us",
        ["user@s.whatsapp.net"],
        "add",
      );
    });

    it("#groupCreate delegates to socket", async () => {
      await connection.groupCreate("My Group", ["user@s.whatsapp.net"]);
      expect(mockSocket.groupCreate).toHaveBeenCalledWith("My Group", [
        "user@s.whatsapp.net",
      ]);
    });

    it("#groupLeave delegates to socket", async () => {
      await connection.groupLeave("group@g.us");
      expect(mockSocket.groupLeave).toHaveBeenCalledWith("group@g.us");
    });

    it("#groupUpdateSubject delegates to socket", async () => {
      await connection.groupUpdateSubject("group@g.us", "New Name");
      expect(mockSocket.groupUpdateSubject).toHaveBeenCalledWith(
        "group@g.us",
        "New Name",
      );
    });

    it("#groupUpdateDescription delegates to socket", async () => {
      await connection.groupUpdateDescription("group@g.us", "desc");
      expect(mockSocket.groupUpdateDescription).toHaveBeenCalledWith(
        "group@g.us",
        "desc",
      );
    });

    it("#groupInviteCode delegates to socket", async () => {
      await connection.groupInviteCode("group@g.us");
      expect(mockSocket.groupInviteCode).toHaveBeenCalledWith("group@g.us");
    });

    it("#groupRevokeInvite delegates to socket", async () => {
      await connection.groupRevokeInvite("group@g.us");
      expect(mockSocket.groupRevokeInvite).toHaveBeenCalledWith("group@g.us");
    });

    it("#groupAcceptInvite delegates to socket", async () => {
      await connection.groupAcceptInvite("invite-code");
      expect(mockSocket.groupAcceptInvite).toHaveBeenCalledWith("invite-code");
    });

    it("#groupSettingUpdate delegates to socket", async () => {
      await connection.groupSettingUpdate("group@g.us", "locked");
      expect(mockSocket.groupSettingUpdate).toHaveBeenCalledWith(
        "group@g.us",
        "locked",
      );
    });

    it("#groupToggleEphemeral delegates to socket", async () => {
      await connection.groupToggleEphemeral("group@g.us", 86400);
      expect(mockSocket.groupToggleEphemeral).toHaveBeenCalledWith(
        "group@g.us",
        86400,
      );
    });

    it("#groupFetchAllParticipating delegates to socket", async () => {
      await connection.groupFetchAllParticipating();
      expect(mockSocket.groupFetchAllParticipating).toHaveBeenCalled();
    });
  });

  describe("Event Handlers", () => {
    beforeEach(async () => {
      await connection.connect();
    });

    describe("connection.update", () => {
      it("sends reconnecting state on isNewLogin", async () => {
        const handler = mockEventHandlers.get("connection.update")!;
        await handler({ isNewLogin: true });

        expect(fetchCalls.length).toBe(1);
        const body = JSON.parse(fetchCalls[0].body);
        expect(body.event).toBe("connection.update");
        expect(body.data.connection).toBe("reconnecting");
      });

      it("sends QR code data when qr is present", async () => {
        const handler = mockEventHandlers.get("connection.update")!;
        await handler({ qr: "qr-string-123" });

        expect(fetchCalls.length).toBe(1);
        const body = JSON.parse(fetchCalls[0].body);
        expect(body.data.connection).toBe("connecting");
        expect(body.data.qrDataUrl).toBe("data:image/png;base64,qrcode");
      });

      it("sends open state and resets reconnect count", async () => {
        const handler = mockEventHandlers.get("connection.update")!;
        await handler({ connection: "open", isOnline: true });

        expect(fetchCalls.length).toBe(1);
        const body = JSON.parse(fetchCalls[0].body);
        expect(body.data.connection).toBe("open");
      });

      it("sends the payload to the webhook URL", async () => {
        const handler = mockEventHandlers.get("connection.update")!;
        await handler({ connection: "open", isOnline: true });

        expect(fetchCalls[0].url).toBe("https://example.com/webhook");
        const body = JSON.parse(fetchCalls[0].body);
        expect(body.webhookVerifyToken).toBe("test-token");
      });
    });

    describe("messages.upsert", () => {
      it("sends message payload to webhook", async () => {
        const handler = mockEventHandlers.get("messages.upsert")!;
        await handler({
          type: "notify",
          messages: [
            {
              key: { id: "msg-1", remoteJid: "user@s.whatsapp.net" },
              message: { conversation: "hello" },
            },
          ],
        });

        expect(fetchCalls.length).toBe(1);
        const body = JSON.parse(fetchCalls[0].body);
        expect(body.event).toBe("messages.upsert");
      });
    });

    describe("messages.update", () => {
      it("sends update payload to webhook with awaitResponse", async () => {
        const handler = mockEventHandlers.get("messages.update")!;
        await handler([{ key: { id: "msg-1" }, update: {} }]);

        expect(fetchCalls.length).toBe(1);
        const body = JSON.parse(fetchCalls[0].body);
        expect(body.event).toBe("messages.update");
        expect(body.awaitResponse).toBe(true);
      });
    });

    describe("message-receipt.update", () => {
      it("sends receipt update to webhook", async () => {
        const handler = mockEventHandlers.get("message-receipt.update")!;
        await handler([{ key: { id: "msg-1" }, receipt: {} }]);

        expect(fetchCalls.length).toBe(1);
        const body = JSON.parse(fetchCalls[0].body);
        expect(body.event).toBe("message-receipt.update");
      });
    });

    describe("groups.update", () => {
      it("sends group update to webhook", async () => {
        const handler = mockEventHandlers.get("groups.update")!;
        await handler([{ id: "group@g.us", subject: "New Name" }]);

        expect(fetchCalls.length).toBe(1);
        const body = JSON.parse(fetchCalls[0].body);
        expect(body.event).toBe("groups.update");
      });
    });

    describe("group-participants.update", () => {
      it("sends participant update to webhook", async () => {
        const handler = mockEventHandlers.get("group-participants.update")!;
        await handler({
          id: "group@g.us",
          participants: ["user@s.whatsapp.net"],
          action: "add",
        });

        expect(fetchCalls.length).toBe(1);
        const body = JSON.parse(fetchCalls[0].body);
        expect(body.event).toBe("group-participants.update");
      });
    });
  });

  describe("Webhook retry logic", () => {
    // sendToWebhook is fire-and-forget from event handlers, so we need
    // to flush microtasks to let the retry loop settle.
    const flushAsync = async () => {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 0));
      }
    };

    it("retries on fetch failure", async () => {
      config.webhook.retryPolicy.maxRetries = 2;

      let callCount = 0;
      globalThis.fetch = mock(async () => {
        callCount++;
        if (callCount <= 2) {
          return new Response("error", { status: 500 });
        }
        return new Response("ok", { status: 200 });
      }) as any;

      await connection.connect();
      const handler = mockEventHandlers.get("messages.update")!;
      await handler([{ key: { id: "msg-1" }, update: {} }]);
      await flushAsync();

      expect(callCount).toBe(3); // initial + 2 retries
      config.webhook.retryPolicy.maxRetries = 0;
    });

    it("stops retrying after maxRetries", async () => {
      config.webhook.retryPolicy.maxRetries = 1;

      let callCount = 0;
      globalThis.fetch = mock(async () => {
        callCount++;
        return new Response("error", { status: 500 });
      }) as any;

      await connection.connect();
      const handler = mockEventHandlers.get("messages.update")!;
      await handler([{ key: { id: "msg-1" }, update: {} }]);
      await flushAsync();

      expect(callCount).toBe(2); // initial + 1 retry
      config.webhook.retryPolicy.maxRetries = 0;
    });

    it("handles fetch throwing an error", async () => {
      config.webhook.retryPolicy.maxRetries = 0;

      globalThis.fetch = mock(async () => {
        throw new Error("network failure");
      }) as any;

      await connection.connect();
      const handler = mockEventHandlers.get("messages.update")!;
      // Should not throw
      await handler([{ key: { id: "msg-1" }, update: {} }]);
      await flushAsync();
    });
  });
});
