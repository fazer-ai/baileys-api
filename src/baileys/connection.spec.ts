import { describe, it, expect, beforeEach, mock } from "bun:test";
import { BaileysConnection, BaileysNotConnectedError } from "./connection";
import type { BaileysConnectionOptions } from "./types";

function createMockSocket(overrides = {}) {
  return {
    profilePictureUrl: mock(() => Promise.resolve("https://example.com/profile.jpg")),
    ...overrides
  };
}

function createBaileysConnection(phoneNumber = "5511999999999") {
  const options: BaileysConnectionOptions = {
    webhookUrl: "http://localhost:3000/webhook",
    webhookVerifyToken: "test-token",
  };
  return new BaileysConnection(phoneNumber, options);
}

function setupConnectionWithMockSocket(socketOverrides = {}) {
  const connection = createBaileysConnection();
  const mockSocket = createMockSocket(socketOverrides);
  // @ts-ignore - Setting private property for testing
  connection.socket = mockSocket;
  return { connection, mockSocket };
}

describe("BaileysConnection", () => {
  describe("#connect", () => {
    it.todo("do nothing if a socket is already connected");
    it.todo("initialize Redis auth state");
    it.todo("create a WA socket with correct options");
    it.todo("register all event listeners on the socket");
  });

  describe("#logout", () => {
    it.todo("throw BaileysNotConnectedError if not connected");
    it.todo("call socket logout method");
    it.todo("clear auth state and remove socket");
  });

  describe("#sendMessage", () => {
    it.todo("throw BaileysNotConnectedError if not connected");
    it.todo("call socket sendMessage method");
    describe("when message is audio", () => {
      it.todo("preprocess audio message");
      it.todo("logs error during audio preprocessing");
    });
  });

  describe("#sendPresenceUpdate", () => {
    it.todo("throw BaileysNotConnectedError if not connected");
    describe("when auth state is not available", () => {
      it.todo("return early without sending presence");
    });
    it.todo("call socket sendPresenceUpdate method");
    it.todo("manage the 'available' presence timeout");
  });

  describe("#readMessages", () => {
    it.todo("throw BaileysNotConnectedError if not connected");
    it.todo("call socket readMessages method");
  });

  describe("#chatModify", () => {
    it.todo("throw BaileysNotConnectedError if not connected");
    it.todo("call socket chatModify method");
  });

  describe("#fetchMessageHistory", () => {
    it.todo("throw BaileysNotConnectedError if not connected");
    it.todo("call socket fetchMessageHistory method");
  });

  describe("#getProfilePicture", () => {
    let connection: BaileysConnection;

    beforeEach(() => {
      connection = createBaileysConnection();
    });

    it("should throw BaileysNotConnectedError if not connected", async () => {
      expect(async () => {
        await connection.getProfilePicture("5511888888888@s.whatsapp.net");
      }).toThrow(BaileysNotConnectedError);
    });

    it("should call socket profilePictureUrl method with correct parameters", async () => {
      const { connection, mockSocket } = setupConnectionWithMockSocket();
      const jid = "5511888888888@s.whatsapp.net";
      const type = "preview";
      await connection.getProfilePicture(jid, type);
      expect(mockSocket.profilePictureUrl).toHaveBeenCalledWith(jid, type);
    });

    it("should return profile picture URL when available", async () => {
      const { connection } = setupConnectionWithMockSocket();
      const result = await connection.getProfilePicture("5511888888888@s.whatsapp.net");
      expect(result).toBe("https://example.com/profile.jpg");
    });

    it("should handle when profile picture is not available", async () => {
      const { connection } = setupConnectionWithMockSocket({
        profilePictureUrl: mock(() => Promise.resolve(null)),
      });
      const result = await connection.getProfilePicture("5511888888888@s.whatsapp.net");
      expect(result).toBeNull();
    });
  });

  describe("Event Handlers", () => {
    describe("connection.update", () => {
      it.todo("handle 'reconnecting' state");
      it.todo("handle 'close' state and attempt to reconnect");
      it.todo("handle 'close' with 'loggedOut' reason and not reconnect");
      it.todo("handle 'open' state with invalid phone number");
      it.todo("generate QR code data URL");
      it.todo("send connection updates to the webhook");
    });

    describe("messages.upsert", () => {
      it.todo("call download media from messages");
      it.todo("call download media from messages with includeMedia");
      it.todo("send the message payload with media to the webhook");
    });

    describe("messages.update", () => {
      it.todo("send the updated message payload with media to the webhook");
    });

    describe("message-receipt.update", () => {
      it.todo("send the message receipt update payload to the webhook");
    });

    describe("messaging-history.set", () => {
      it.todo("download media from history messages");
      it.todo("send the history payload to the webhook");
    });
  });

  describe("Webhook Logic", () => {
    it.todo("send payload to the configured webhook URL");
    it.todo("retry sending the webhook on failure");
    it.todo("stop retrying after reaching the max number of retries");
    it.todo("handle webhook timeouts appropriately");
    it.todo("handle malformed webhook URLs");
    it.todo("handle webhook responses with error status codes");
  });
});
