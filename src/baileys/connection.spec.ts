import { describe, it } from "bun:test";

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

  describe("#profilePictureUrl", () => {
    it.todo("should return an error when profile picture is not found");
    it.todo(
      "should call socket profilePictureUrl method with correct parameters",
    );
    it.todo("should return profile picture URL when available");
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
