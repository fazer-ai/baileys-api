import { describe, it, expect, mock } from "bun:test";
import { BaileysConnectionsHandler } from "./connectionsHandler";
import { BaileysNotConnectedError } from "./connection";

function createMockConnection(overrides = {}) {
  return {
    getProfilePicture: mock(() => Promise.resolve("https://example.com/profile.jpg")),
    ...overrides
  };
}

function setupHandlerWithConnection(phoneNumber: string, mockConnection: any) {
  const handler = new BaileysConnectionsHandler();
  // @ts-ignore - Setting private property for testing
  handler.connections = { [phoneNumber]: mockConnection };
  return { handler, mockConnection };
}

describe("BaileysConnectionsHandler", () => {
  describe("#reconnectFromAuthStore", () => {
    describe("when no saved connections exist", () => {
      it.todo("logs no saved connections and returns");
    });
    describe("when saved connections exist", () => {
      it.todo("logs the number of saved connections");
      it.todo(
        "creates and connects a BaileysConnection for each saved auth state",
      );
      it.todo(
        "sets up the onConnectionClose callback to remove the connection",
      );
    });
  });

  describe("#connect", () => {
    it.todo(
      "create a new BaileysConnection, connect and store it in the handler",
    );
    it.todo(
      "send a presence update if a connection for the number already exists",
    );
  });

  describe("#sendPresenceUpdate", () => {
    it.todo("throw BaileysNotConnectedError if no connection exists");
    it.todo("call sendPresenceUpdate on the correct connection");
  });

  describe("#sendMessage", () => {
    it.todo("throw BaileysNotConnectedError if no connection exists");
    it.todo("call sendMessage on the correct connection");
  });

  describe("#readMessages", () => {
    it.todo("throw BaileysNotConnectedError if no connection exists");
    it.todo("call readMessages on the correct connection");
  });

  describe("#chatModify", () => {
    it.todo("throw BaileysNotConnectedError if no connection exists");
    it.todo("call chatModify on the correct connection");
  });

  describe("#fetchMessageHistory", () => {
    it.todo("throw BaileysNotConnectedError if no connection exists");
    it.todo("call fetchMessageHistory on the correct connection");
  });

  describe("#getProfilePicture", () => {
    let handler: BaileysConnectionsHandler;

    it("should throw BaileysNotConnectedError if no connection exists", async () => {
      handler = new BaileysConnectionsHandler();
      expect(async () => {
        await handler.getProfilePicture("5511999999999", "5511888888888@s.whatsapp.net");
      }).toThrow(BaileysNotConnectedError);
    });

    it("should call getProfilePicture on the correct connection", async () => {
      const mockConnection = createMockConnection();
      const { handler } = setupHandlerWithConnection("5511999999999", mockConnection);
      const jid = "5511888888888@s.whatsapp.net";
      const type = "preview";
      await handler.getProfilePicture("5511999999999", jid, type);
      expect(mockConnection.getProfilePicture).toHaveBeenCalledWith(jid, type);
    });

    it("should return profile picture URL when available", async () => {
      const mockConnection = createMockConnection();
      const { handler } = setupHandlerWithConnection("5511999999999", mockConnection);
      const result = await handler.getProfilePicture("5511999999999", "5511888888888@s.whatsapp.net");
      expect(result).toBe("https://example.com/profile.jpg");
    });

    it("should return null when profile picture is not available", async () => {
      const mockConnection = createMockConnection({ 
        getProfilePicture: mock(() => Promise.resolve(null)) 
      });
      const { handler } = setupHandlerWithConnection("5511999999999", mockConnection);
      const result = await handler.getProfilePicture("5511999999999", "5511888888888@s.whatsapp.net");
      expect(result).toBeNull();
    });
  });

  describe("#logout", () => {
    it.todo("throw BaileysNotConnectedError if no connection exists");
    it.todo("call logout on the correct connection");
    it.todo("remove the connection from the handler after logout");
  });

  describe("#logoutAll", () => {
    it.todo("call logout on all active connections");
    it.todo("clear all connections from the handler after logout");
  });
});
