import { beforeEach, describe, expect, it, mock } from "bun:test";

// Logger and asyncSleep are mocked in preload.ts

// Track BaileysConnection instances
const mockConnectionInstances: Map<string, any> = new Map();

const mockConnect = mock(async function (this: any) {});
const mockLogout = mock(async function (this: any) {});
const mockDiscard = mock(function (this: any) {});
const mockSendPresenceUpdate = mock(async function (this: any) {});
const mockSendMessage = mock(async function (this: any) {});
const mockReadMessages = mock(async function (this: any) {});
const mockChatModify = mock(async function (this: any) {});
const mockFetchMessageHistory = mock(async function (this: any) {});
const mockSendReceipts = mock(async function (this: any) {});
const mockDeleteMessage = mock(async function (this: any) {});
const mockEditMessage = mock(async function (this: any) {});
const mockProfilePictureUrl = mock(async function (this: any) {
  return "https://example.com/pic.jpg";
});
const mockUpdateOptions = mock(function (this: any, options: any) {
  if (options.apiKeyHash !== undefined) {
    this._apiKeyHash = options.apiKeyHash;
  }
});
const mockOnWhatsApp = mock(async function (this: any) {
  return [];
});
const mockGetBusinessProfile = mock(async function (this: any) {});
const mockGroupMetadata = mock(async function (this: any) {});
const mockGroupParticipants = mock(async function (this: any) {});
const mockGroupCreate = mock(async function (this: any) {});
const mockGroupLeave = mock(async function (this: any) {});
const mockGroupUpdateSubject = mock(async function (this: any) {});
const mockGroupUpdateDescription = mock(async function (this: any) {});
const mockGroupRequestParticipantsList = mock(async function (this: any) {
  return [];
});
const mockGroupRequestParticipantsUpdate = mock(async function (this: any) {});
const mockGroupInviteCode = mock(async function (this: any) {
  return "invite-code";
});
const mockGroupRevokeInvite = mock(async function (this: any) {
  return "new-invite";
});
const mockGroupAcceptInvite = mock(async function (this: any) {
  return "group-jid";
});
const mockGroupRevokeInviteV4 = mock(async function (this: any) {});
const mockGroupAcceptInviteV4 = mock(async function (this: any) {
  return "group-jid";
});
const mockGroupGetInviteInfo = mock(async function (this: any) {
  return {};
});
const mockGroupToggleEphemeral = mock(async function (this: any) {});
const mockGroupSettingUpdate = mock(async function (this: any) {});
const mockGroupMemberAddMode = mock(async function (this: any) {});
const mockGroupJoinApprovalMode = mock(async function (this: any) {});
const mockGroupFetchAllParticipating = mock(async function (this: any) {
  return {};
});
const mockPresenceSubscribe = mock(async function (this: any) {
  return { subscribed: [] };
});

class MockBaileysConnection {
  phoneNumber: string;
  options: any;
  _apiKeyHash: string | null;
  inFlightWebhooks = 0;
  lastTrafficAt: number | null = null;

  constructor(phoneNumber: string, options: any) {
    this.phoneNumber = phoneNumber;
    this.options = options;
    this._apiKeyHash = options.apiKeyHash ?? null;
    mockConnectionInstances.set(phoneNumber, this);
  }

  get apiKeyHash() {
    return this._apiKeyHash;
  }
  connect = mockConnect;
  logout = mockLogout;
  discard = mockDiscard;
  sendPresenceUpdate = mockSendPresenceUpdate;
  sendMessage = mockSendMessage;
  readMessages = mockReadMessages;
  chatModify = mockChatModify;
  fetchMessageHistory = mockFetchMessageHistory;
  sendReceipts = mockSendReceipts;
  deleteMessage = mockDeleteMessage;
  editMessage = mockEditMessage;
  profilePictureUrl = mockProfilePictureUrl;
  updateOptions = mockUpdateOptions;
  onWhatsApp = mockOnWhatsApp;
  getBusinessProfile = mockGetBusinessProfile;
  groupMetadata = mockGroupMetadata;
  groupParticipants = mockGroupParticipants;
  groupCreate = mockGroupCreate;
  groupLeave = mockGroupLeave;
  groupUpdateSubject = mockGroupUpdateSubject;
  groupUpdateDescription = mockGroupUpdateDescription;
  groupRequestParticipantsList = mockGroupRequestParticipantsList;
  groupRequestParticipantsUpdate = mockGroupRequestParticipantsUpdate;
  groupInviteCode = mockGroupInviteCode;
  groupRevokeInvite = mockGroupRevokeInvite;
  groupAcceptInvite = mockGroupAcceptInvite;
  groupRevokeInviteV4 = mockGroupRevokeInviteV4;
  groupAcceptInviteV4 = mockGroupAcceptInviteV4;
  groupGetInviteInfo = mockGroupGetInviteInfo;
  groupToggleEphemeral = mockGroupToggleEphemeral;
  groupSettingUpdate = mockGroupSettingUpdate;
  groupMemberAddMode = mockGroupMemberAddMode;
  groupJoinApprovalMode = mockGroupJoinApprovalMode;
  groupFetchAllParticipating = mockGroupFetchAllParticipating;
  presenceSubscribe = mockPresenceSubscribe;
}

import {
  BaileysConnectionForbiddenError,
  BaileysNotConnectedError,
} from "@/baileys/connection";
import redis from "@/lib/redis";
import { BaileysConnectionsHandler } from "./connectionsHandler";

describe("BaileysConnectionsHandler", () => {
  let handler: BaileysConnectionsHandler;

  const defaultOptions = {
    webhookUrl: "https://example.com/webhook",
    webhookVerifyToken: "test-token",
  };

  beforeEach(() => {
    handler = new BaileysConnectionsHandler(
      (phone, opts) => new MockBaileysConnection(phone, opts) as any,
    );
    mockConnectionInstances.clear();
    mockConnect.mockClear();
    mockLogout.mockClear();
    mockDiscard.mockClear();
    mockSendPresenceUpdate.mockClear();
    mockSendMessage.mockClear();
    mockReadMessages.mockClear();
    mockChatModify.mockClear();
    mockFetchMessageHistory.mockClear();
    mockSendReceipts.mockClear();
    mockDeleteMessage.mockClear();
    mockEditMessage.mockClear();
    mockProfilePictureUrl.mockClear();
    mockUpdateOptions.mockClear();
    mockOnWhatsApp.mockClear();
    mockGetBusinessProfile.mockClear();
    mockGroupMetadata.mockClear();
    mockGroupParticipants.mockClear();
    mockGroupCreate.mockClear();
    mockGroupLeave.mockClear();
    mockGroupUpdateSubject.mockClear();
    mockGroupUpdateDescription.mockClear();
    mockGroupRequestParticipantsList.mockClear();
    mockGroupRequestParticipantsUpdate.mockClear();
    mockGroupInviteCode.mockClear();
    mockGroupRevokeInvite.mockClear();
    mockGroupAcceptInvite.mockClear();
    mockGroupRevokeInviteV4.mockClear();
    mockGroupAcceptInviteV4.mockClear();
    mockGroupGetInviteInfo.mockClear();
    mockGroupToggleEphemeral.mockClear();
    mockGroupSettingUpdate.mockClear();
    mockGroupMemberAddMode.mockClear();
    mockGroupJoinApprovalMode.mockClear();
    mockGroupFetchAllParticipating.mockClear();
    mockPresenceSubscribe.mockClear();
  });

  describe("#discardConnection", () => {
    it("discards the connection and removes it without touching auth state", async () => {
      await handler.connect("+5511999", defaultOptions);
      mockDiscard.mockClear();

      await handler.discardConnection("+5511999");

      expect(mockDiscard).toHaveBeenCalledTimes(1);
      expect(mockLogout).not.toHaveBeenCalled();
      expect(handler.hasConnection("+5511999")).toBe(false);
    });

    it("is a no-op when the connection does not exist", async () => {
      await handler.discardConnection("+5511999");
      expect(mockDiscard).not.toHaveBeenCalled();
    });

    it("keeps in-flight webhooks of a discarded connection visible until they drain", async () => {
      // The shutdown drain waits on inFlightWebhookCount() AFTER discarding
      // each phone — a discarded connection with a retrying webhook must
      // still hold the drain open or the process exits mid-delivery.
      await handler.connect("+5511999", defaultOptions);
      const connection = mockConnectionInstances.get("+5511999")!;
      connection.inFlightWebhooks = 2;

      await handler.discardConnection("+5511999");

      expect(handler.hasConnection("+5511999")).toBe(false);
      expect(handler.inFlightWebhookCount()).toBe(2);

      connection.inFlightWebhooks = 0;
      expect(handler.inFlightWebhookCount()).toBe(0);
    });

    it("waits for an in-flight spawn before discarding", async () => {
      // A self-fence arriving while a connect is mid-flight must not run
      // before the spawn settles — otherwise the freshly created socket
      // would survive the discard, still authenticated with the identity
      // that now belongs to another instance.
      let resolveSlowConnect: () => void = () => {};
      mockConnect.mockImplementationOnce(
        () =>
          new Promise<void>((res) => {
            resolveSlowConnect = res;
          }),
      );

      const connectPromise = handler.connect("+5511999", defaultOptions);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const discardPromise = handler.discardConnection("+5511999");
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      expect(mockDiscard).not.toHaveBeenCalled();

      resolveSlowConnect();
      await connectPromise;
      await discardPromise;

      expect(mockDiscard).toHaveBeenCalledTimes(1);
      expect(handler.hasConnection("+5511999")).toBe(false);
    });
  });

  describe("accessors", () => {
    it("exposes active phone numbers and size", async () => {
      expect(handler.size).toBe(0);
      expect(handler.getActivePhoneNumbers()).toEqual([]);

      await handler.connect("+5511999", defaultOptions);
      await handler.connect("+5521888", defaultOptions);

      expect(handler.size).toBe(2);
      expect(handler.getActivePhoneNumbers().sort()).toEqual([
        "+5511999",
        "+5521888",
      ]);
      expect(handler.hasConnection("+5511999")).toBe(true);
      expect(handler.hasConnection("+5530000")).toBe(false);
    });

    it("exposes per-connection activity", async () => {
      await handler.connect("+5511999", defaultOptions);

      expect(handler.connectionActivity("+5511999")).toEqual({
        inFlightWebhooks: 0,
        lastTrafficAt: null,
      });
      expect(handler.connectionActivity("+5530000")).toBeNull();
    });
  });

  describe("#connect", () => {
    it("creates a new connection and stores it", async () => {
      await handler.connect("+5511999", defaultOptions);
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it("updates options and sends presence if connection already exists", async () => {
      await handler.connect("+5511999", defaultOptions);
      mockConnect.mockClear();
      mockSendPresenceUpdate.mockClear();

      await handler.connect("+5511999", {
        ...defaultOptions,
        clientName: "Updated",
      });

      expect(mockUpdateOptions).toHaveBeenCalled();
      expect(mockSendPresenceUpdate).toHaveBeenCalledWith("available");
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it("forceRestart discards a live connection and spawns a fresh one", async () => {
      // An import re-seeds creds in Redis; a reused in-memory socket (e.g. one
      // still emitting QRs) would ignore them, so forceRestart must replace it.
      await handler.connect("+5511999", defaultOptions);
      mockConnect.mockClear();
      mockDiscard.mockClear();
      mockSendPresenceUpdate.mockClear();
      mockUpdateOptions.mockClear();

      await handler.connect("+5511999", {
        ...defaultOptions,
        forceRestart: true,
      });

      // Old socket torn down, brand-new one spawned, no reuse via presence.
      expect(mockDiscard).toHaveBeenCalledTimes(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockSendPresenceUpdate).not.toHaveBeenCalled();
      expect(mockUpdateOptions).not.toHaveBeenCalled();
    });

    it("handles inconsistent connection state when sendPresenceUpdate throws BaileysNotConnectedError", async () => {
      await handler.connect("+5511999", defaultOptions);
      mockConnect.mockClear();
      mockSendPresenceUpdate.mockRejectedValueOnce(
        new BaileysNotConnectedError(),
      );

      await handler.connect("+5511999", defaultOptions);
      // Should create a new connection and discard the stale one so its
      // pending reconnect (e.g. after a connectionReplaced backoff) cannot
      // resurrect a parallel socket.
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockDiscard).toHaveBeenCalledTimes(1);
    });

    it("re-throws non-BaileysNotConnectedError errors", async () => {
      await handler.connect("+5511999", defaultOptions);
      mockSendPresenceUpdate.mockRejectedValueOnce(
        new Error("unexpected error"),
      );

      await expect(handler.connect("+5511999", defaultOptions)).rejects.toThrow(
        "unexpected error",
      );
    });

    it("calls onConnectionClose callback and removes connection on close", async () => {
      const onClose = mock(() => {});
      await handler.connect("+5511999", {
        ...defaultOptions,
        onConnectionClose: onClose,
      });

      // Simulate the connection closing by calling the onConnectionClose callback
      const instance = mockConnectionInstances.get("+5511999");
      instance.options.onConnectionClose();

      expect(onClose).toHaveBeenCalled();
      // Connection should be removed after close
      expect(() =>
        handler.sendPresenceUpdate("+5511999", { type: "available" }),
      ).toThrow(BaileysNotConnectedError);
    });

    it("does not spawn a parallel connection when a POST arrives during a boot reconnect", async () => {
      // Reproduces the race condition where a POST /connections/<phone> arrives
      // while a boot reconnect (today: the coordinator claim cycle) is mid-flight:
      // the in-flight connection has already been registered in
      // `this.connections[id]` but its `connect()` is still awaiting (in
      // production: useRedisAuthState before makeWASocket), so
      // `sendPresenceUpdate` throws BaileysNotConnectedError. Without proper
      // serialization the handler then creates a SECOND parallel connection with
      // the same identity, producing two sockets that fight on the WhatsApp side
      // with conflict/replaced in a loop.
      let resolveSlowConnect: () => void = () => {};
      const slowConnect = new Promise<void>((res) => {
        resolveSlowConnect = res;
      });
      let connectACompleted = false;

      // First connect() (from the boot reconnect) blocks until released.
      // Mirrors `await useRedisAuthState()` running before `makeWASocket()`.
      mockConnect.mockImplementationOnce(async () => {
        await slowConnect;
        connectACompleted = true;
      });

      // sendPresenceUpdate throws only while the socket isn't ready (i.e. the
      // in-flight connect hasn't completed yet). After it completes, the
      // socket exists and presence updates succeed.
      mockSendPresenceUpdate.mockImplementationOnce(async () => {
        if (!connectACompleted) throw new BaileysNotConnectedError();
      });

      // Fire the boot reconnect without awaiting — it registers
      // this.connections[+5511999] and parks on slowConnect.
      const reconnectPromise = handler.connect("+5511999", {
        isReconnect: true,
        webhookUrl: "https://hook.com",
        webhookVerifyToken: "t",
      });
      // Let the reconnect microtasks run so the connection is registered.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // Simulate POST /connections/+5511999 from chatwoot mid-flight.
      // Don't await yet — the fix makes this await the in-flight connect.
      const connectPromise = handler.connect("+5511999", defaultOptions);
      // Yield enough times for connect() to reach `await inFlight`.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // Unblock the in-flight connect() and let everything finish.
      resolveSlowConnect();
      await connectPromise;
      await reconnectPromise;

      // Exactly one BaileysConnection.connect() must have happened — the in-flight
      // one. The handler must NOT have created a parallel socket.
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it("serializes concurrent connect calls for the same number", async () => {
      // Two POSTs arriving at the same time for the same number must not produce
      // two parallel BaileysConnections, since both would auth with the same
      // identity and the WhatsApp server kicks both with conflict/replaced.
      let resolveFirstConnect: () => void = () => {};
      const firstConnect = new Promise<void>((res) => {
        resolveFirstConnect = res;
      });

      mockConnect.mockImplementationOnce(async () => {
        await firstConnect;
      });

      const first = handler.connect("+5511999", defaultOptions);
      const second = handler.connect("+5511999", defaultOptions);

      // Let microtasks settle so both callers parked appropriately.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      resolveFirstConnect();
      await first;
      await second;

      // Only one BaileysConnection.connect() call: the second caller reused
      // the first one via sendPresenceUpdate, not a parallel socket.
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockSendPresenceUpdate).toHaveBeenCalledWith("available");
    });

    it("re-validates state after BaileysNotConnectedError instead of spawning unconditionally", async () => {
      // Two concurrent callers can both reach `sendPresenceUpdate` on the same
      // stale connection, both receive BaileysNotConnectedError, and both
      // unconditionally call spawnConnection. The second caller must re-check
      // the in-flight slot after the recovery branch, otherwise we end up with
      // two parallel replacement sockets — the exact bug the lock is meant to
      // prevent, just shifted to the recovery path.
      await handler.connect("+5511999", defaultOptions);
      expect(mockConnect).toHaveBeenCalledTimes(1);

      let rejectSpu1: (e: unknown) => void = () => {};
      let rejectSpu2: (e: unknown) => void = () => {};
      mockSendPresenceUpdate.mockImplementationOnce(
        () =>
          new Promise((_, rej) => {
            rejectSpu1 = rej;
          }),
      );
      mockSendPresenceUpdate.mockImplementationOnce(
        () =>
          new Promise((_, rej) => {
            rejectSpu2 = rej;
          }),
      );

      const first = handler.connect("+5511999", defaultOptions);
      const second = handler.connect("+5511999", defaultOptions);

      // Let both callers park on `await sendPresenceUpdate`.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // Both fail at once with the stale-socket error.
      rejectSpu1(new BaileysNotConnectedError());
      rejectSpu2(new BaileysNotConnectedError());

      await first;
      await second;

      // 1 initial + 1 replacement spawn — NOT 3 (initial + 2 parallel replacements).
      expect(mockConnect).toHaveBeenCalledTimes(2);
    });

    it("does not let an old connection's onConnectionClose evict a replacement", async () => {
      // After the inconsistent-state recovery path (BaileysNotConnectedError),
      // a new connection takes the slot. If the OLD connection later fires
      // onConnectionClose, it must NOT delete the replacement's entry.
      await handler.connect("+5511999", defaultOptions);
      const oldInstance = mockConnectionInstances.get("+5511999");

      mockSendPresenceUpdate.mockRejectedValueOnce(
        new BaileysNotConnectedError(),
      );
      await handler.connect("+5511999", defaultOptions);
      const newInstance = mockConnectionInstances.get("+5511999");
      expect(newInstance).not.toBe(oldInstance);

      // Old connection's WS finally closes long after the replacement is live.
      oldInstance.options.onConnectionClose();

      // Replacement must still be tracked.
      expect(() =>
        handler.sendPresenceUpdate("+5511999", { type: "available" }),
      ).not.toThrow();
    });
  });

  describe("#verifyConnectionAccess", () => {
    it("does nothing when no connection exists and no Redis metadata", async () => {
      // Should not throw
      await handler.verifyConnectionAccess("+5511999", "some-hash");
    });

    it("does nothing when connection has no apiKeyHash", async () => {
      await handler.connect("+5511999", defaultOptions);
      // Should not throw
      await handler.verifyConnectionAccess("+5511999", "some-hash");
    });

    it("does nothing when hashes match", async () => {
      await handler.connect("+5511999", {
        ...defaultOptions,
        apiKeyHash: "matching-hash",
      });
      // Should not throw
      await handler.verifyConnectionAccess("+5511999", "matching-hash");
    });

    it("throws BaileysConnectionForbiddenError when hashes don't match", async () => {
      await handler.connect("+5511999", {
        ...defaultOptions,
        apiKeyHash: "hash-a",
      });
      await expect(
        handler.verifyConnectionAccess("+5511999", "hash-b"),
      ).rejects.toThrow(BaileysConnectionForbiddenError);
    });

    it("checks Redis metadata when connection is not in memory", async () => {
      // Simulate persisted metadata in Redis without an active connection
      const hashData = (redis as any).__hashData;
      hashData.set(
        "@baileys-api:connections:+5511999:authState",
        new Map([
          ["metadata", JSON.stringify({ apiKeyHash: "persisted-hash" })],
        ]),
      );

      // Same hash should pass
      await handler.verifyConnectionAccess("+5511999", "persisted-hash");

      // Different hash should throw
      await expect(
        handler.verifyConnectionAccess("+5511999", "wrong-hash"),
      ).rejects.toThrow(BaileysConnectionForbiddenError);
    });
  });

  describe("#sendPresenceUpdate", () => {
    it("throws BaileysNotConnectedError when connection does not exist", () => {
      expect(() =>
        handler.sendPresenceUpdate("+5511999", { type: "available" }),
      ).toThrow(BaileysNotConnectedError);
    });

    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      mockSendPresenceUpdate.mockClear();
      handler.sendPresenceUpdate("+5511999", {
        type: "composing",
        toJid: "5521888@s.whatsapp.net",
      });
      expect(mockSendPresenceUpdate).toHaveBeenCalledWith(
        "composing",
        "5521888@s.whatsapp.net",
      );
    });
  });

  describe("#sendMessage", () => {
    it("throws BaileysNotConnectedError when connection does not exist", () => {
      expect(() =>
        handler.sendMessage("+5511999", {
          jid: "target@s.whatsapp.net",
          messageContent: { text: "hi" },
        }),
      ).toThrow(BaileysNotConnectedError);
    });

    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      mockSendMessage.mockClear();
      handler.sendMessage("+5511999", {
        jid: "target@s.whatsapp.net",
        messageContent: { text: "hi" },
      });
      expect(mockSendMessage).toHaveBeenCalledWith(
        "target@s.whatsapp.net",
        { text: "hi" },
        { quoted: undefined },
      );
    });
  });

  describe("#readMessages", () => {
    it("throws BaileysNotConnectedError when connection does not exist", () => {
      expect(() => handler.readMessages("+5511999", [])).toThrow(
        BaileysNotConnectedError,
      );
    });

    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      mockReadMessages.mockClear();
      const keys = [{ id: "msg-1" }];
      handler.readMessages("+5511999", keys as any);
      expect(mockReadMessages).toHaveBeenCalledWith(keys);
    });
  });

  describe("#chatModify", () => {
    it("throws BaileysNotConnectedError when connection does not exist", () => {
      expect(() => handler.chatModify("+5511999", {} as any, "jid")).toThrow(
        BaileysNotConnectedError,
      );
    });

    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      mockChatModify.mockClear();
      handler.chatModify(
        "+5511999",
        { markRead: true } as any,
        "jid@s.whatsapp.net",
      );
      expect(mockChatModify).toHaveBeenCalledWith(
        { markRead: true },
        "jid@s.whatsapp.net",
      );
    });
  });

  describe("#fetchMessageHistory", () => {
    it("throws BaileysNotConnectedError when connection does not exist", () => {
      expect(() =>
        handler.fetchMessageHistory("+5511999", {
          count: 10,
          oldestMsgKey: {},
          oldestMsgTimestamp: 0,
        } as any),
      ).toThrow(BaileysNotConnectedError);
    });

    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      mockFetchMessageHistory.mockClear();
      handler.fetchMessageHistory("+5511999", {
        count: 10,
        oldestMsgKey: { id: "old" },
        oldestMsgTimestamp: 12345,
      } as any);
      expect(mockFetchMessageHistory).toHaveBeenCalledWith(
        10,
        { id: "old" },
        12345,
      );
    });
  });

  describe("#profilePictureUrl", () => {
    it("throws BaileysNotConnectedError when connection does not exist", () => {
      expect(() =>
        handler.profilePictureUrl("+5511999", "jid@s.whatsapp.net"),
      ).toThrow(BaileysNotConnectedError);
    });

    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      mockProfilePictureUrl.mockClear();
      handler.profilePictureUrl("+5511999", "jid@s.whatsapp.net", "image");
      expect(mockProfilePictureUrl).toHaveBeenCalledWith(
        "jid@s.whatsapp.net",
        "image",
      );
    });
  });

  describe("#logout", () => {
    it("throws BaileysNotConnectedError when connection does not exist", async () => {
      await expect(handler.logout("+5511999")).rejects.toThrow(
        BaileysNotConnectedError,
      );
    });

    it("calls logout on the connection and removes it", async () => {
      await handler.connect("+5511999", defaultOptions);
      mockLogout.mockClear();

      await handler.logout("+5511999");

      expect(mockLogout).toHaveBeenCalledTimes(1);
      // Connection should be removed, so subsequent calls should throw
      await expect(handler.logout("+5511999")).rejects.toThrow(
        BaileysNotConnectedError,
      );
    });

    it("waits for an in-flight connect before logging out", async () => {
      // A DELETE arriving while a boot reconnect is mid-flight must not
      // beat the spawn — otherwise the freshly created socket would survive
      // a logout that thought there was nothing to do, leaving an orphaned
      // BaileysConnection authenticated with that identity.
      let resolveSlowConnect: () => void = () => {};
      mockConnect.mockImplementationOnce(
        () =>
          new Promise<void>((res) => {
            resolveSlowConnect = res;
          }),
      );

      const reconnectPromise = handler.connect("+5511999", {
        isReconnect: true,
        webhookUrl: "https://h.com",
        webhookVerifyToken: "t",
      });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const logoutPromise = handler.logout("+5511999");
      // Yield so logout reaches the in-flight drain.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // Logout must not have called the connection's logout yet — the spawn
      // is still running.
      expect(mockLogout).not.toHaveBeenCalled();

      resolveSlowConnect();
      await reconnectPromise;
      await logoutPromise;

      // After both settle, the logout drove a real WhatsApp logout on the
      // freshly spawned connection.
      expect(mockLogout).toHaveBeenCalledTimes(1);
    });
  });

  describe("wrong-phone teardown (requestLogout)", () => {
    it("wires a requestLogout that tears the connection down through the lock", async () => {
      await handler.connect("+5511999", defaultOptions);
      const instance = mockConnectionInstances.get("+5511999")!;
      expect(typeof instance.options.requestLogout).toBe("function");
      mockLogout.mockClear();

      // handleWrongPhoneNumber would call this callback.
      instance.options.requestLogout();
      // Fire-and-forget — drain it until the teardown removes the connection.
      while (handler.hasConnection("+5511999")) {
        await new Promise((r) => setImmediate(r));
      }

      expect(mockLogout).toHaveBeenCalledTimes(1);
      expect(handler.hasConnection("+5511999")).toBe(false);
    });

    it("does not run concurrently with an in-flight connect (issue #313)", async () => {
      // A spawn holds the inFlightOps slot. The wrong-phone teardown must park
      // on the lock instead of tearing down (and mutating connections) in
      // parallel with the spawn.
      let releaseConnect: () => void = () => {};
      mockConnect.mockImplementationOnce(
        () =>
          new Promise<void>((res) => {
            releaseConnect = res;
          }),
      );

      const connectPromise = handler.connect("+5511999", defaultOptions);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const instance = mockConnectionInstances.get("+5511999")!;
      mockLogout.mockClear();
      instance.options.requestLogout();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // Parked on the lock: the connection's logout has NOT run yet.
      expect(mockLogout).not.toHaveBeenCalled();

      releaseConnect();
      await connectPromise;
      while (handler.hasConnection("+5511999")) {
        await new Promise((r) => setImmediate(r));
      }

      // After serializing behind the spawn, the teardown ran exactly once.
      expect(mockLogout).toHaveBeenCalledTimes(1);
      expect(handler.hasConnection("+5511999")).toBe(false);
    });

    it("does not tear down a replacement that already took the slot", async () => {
      // The old connection (the one that saw the wrong number) fires its
      // teardown after a replacement has taken its place. The identity check
      // must make it a no-op so the replacement (and the shared auth state it
      // reuses) is left intact.
      await handler.connect("+5511999", defaultOptions);
      const oldInstance = mockConnectionInstances.get("+5511999")!;

      // Force the recovery path so a replacement instance takes the slot.
      mockSendPresenceUpdate.mockRejectedValueOnce(
        new BaileysNotConnectedError(),
      );
      await handler.connect("+5511999", defaultOptions);
      const newInstance = mockConnectionInstances.get("+5511999")!;
      expect(newInstance).not.toBe(oldInstance);

      mockLogout.mockClear();
      // Old connection's wrong-phone teardown fires late.
      oldInstance.options.requestLogout();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // No logout happened (neither old nor new); replacement still tracked.
      expect(mockLogout).not.toHaveBeenCalled();
      expect(handler.hasConnection("+5511999")).toBe(true);
    });
  });

  describe("#logoutAll", () => {
    it("calls logout on all connections and clears the handler", async () => {
      await handler.connect("+5511999", defaultOptions);
      await handler.connect("+5521888", defaultOptions);
      mockLogout.mockClear();

      await handler.logoutAll();

      expect(mockLogout).toHaveBeenCalledTimes(2);
      // All connections removed
      expect(() =>
        handler.sendPresenceUpdate("+5511999", { type: "available" }),
      ).toThrow(BaileysNotConnectedError);
    });

    it("handles empty handler gracefully", async () => {
      await handler.logoutAll();
      // Should not throw
    });

    it("waits for in-flight spawns before iterating connections", async () => {
      // logoutAll must wait for any connection that is still being spawned
      // (e.g. by the coordinator claim cycle on boot). Otherwise the new
      // socket would survive the bulk logout, leaving an orphaned
      // BaileysConnection authenticated with our identity.
      let resolveSlowConnect: () => void = () => {};
      mockConnect.mockImplementationOnce(
        () =>
          new Promise<void>((res) => {
            resolveSlowConnect = res;
          }),
      );

      const reconnectPromise = handler.connect("+5511999", {
        isReconnect: true,
        webhookUrl: "https://h.com",
        webhookVerifyToken: "t",
      });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const logoutAllPromise = handler.logoutAll();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      expect(mockLogout).not.toHaveBeenCalled();

      resolveSlowConnect();
      await reconnectPromise;
      await logoutAllPromise;

      // The spawned connection was reaped by logoutAll once the spawn settled.
      expect(mockLogout).toHaveBeenCalledTimes(1);
    });
  });

  describe("#sendReceipts", () => {
    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      mockSendReceipts.mockClear();
      const keys = [{ id: "msg-1" }];
      handler.sendReceipts("+5511999", { keys } as any);
      expect(mockSendReceipts).toHaveBeenCalledWith(keys, undefined);
    });
  });

  describe("#deleteMessage", () => {
    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      mockDeleteMessage.mockClear();
      handler.deleteMessage("+5511999", {
        jid: "target@s.whatsapp.net",
        key: { id: "msg-1" },
      } as any);
      expect(mockDeleteMessage).toHaveBeenCalledWith("target@s.whatsapp.net", {
        id: "msg-1",
      });
    });
  });

  describe("#editMessage", () => {
    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      mockEditMessage.mockClear();
      handler.editMessage("+5511999", {
        jid: "target@s.whatsapp.net",
        key: { id: "msg-1" },
        messageContent: { text: "edited" },
      } as any);
      expect(mockEditMessage).toHaveBeenCalledWith(
        "target@s.whatsapp.net",
        { id: "msg-1" },
        { text: "edited" },
      );
    });
  });

  describe("#onWhatsApp", () => {
    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      mockOnWhatsApp.mockClear();
      handler.onWhatsApp("+5511999", ["5521888@s.whatsapp.net"]);
      expect(mockOnWhatsApp).toHaveBeenCalledWith(["5521888@s.whatsapp.net"]);
    });
  });

  describe("#groupMetadata", () => {
    it("throws BaileysNotConnectedError when connection does not exist", () => {
      expect(() => handler.groupMetadata("+5511999", "group@g.us")).toThrow(
        BaileysNotConnectedError,
      );
    });

    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      handler.groupMetadata("+5511999", "group@g.us");
      expect(mockGroupMetadata).toHaveBeenCalledWith("group@g.us");
    });
  });

  describe("#groupParticipants", () => {
    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      handler.groupParticipants(
        "+5511999",
        "group@g.us",
        ["user@s.whatsapp.net"],
        "add",
      );
      expect(mockGroupParticipants).toHaveBeenCalledWith(
        "group@g.us",
        ["user@s.whatsapp.net"],
        "add",
      );
    });
  });

  describe("#groupCreate", () => {
    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      handler.groupCreate("+5511999", "My Group", ["user1@s.whatsapp.net"]);
      expect(mockGroupCreate).toHaveBeenCalledWith("My Group", [
        "user1@s.whatsapp.net",
      ]);
    });
  });

  describe("#groupLeave", () => {
    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      handler.groupLeave("+5511999", "group@g.us");
      expect(mockGroupLeave).toHaveBeenCalledWith("group@g.us");
    });
  });

  describe("#groupUpdateSubject", () => {
    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      handler.groupUpdateSubject("+5511999", "group@g.us", "New Name");
      expect(mockGroupUpdateSubject).toHaveBeenCalledWith(
        "group@g.us",
        "New Name",
      );
    });
  });

  describe("#groupUpdateDescription", () => {
    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      handler.groupUpdateDescription(
        "+5511999",
        "group@g.us",
        "New description",
      );
      expect(mockGroupUpdateDescription).toHaveBeenCalledWith(
        "group@g.us",
        "New description",
      );
    });
  });

  describe("#groupRequestParticipantsList", () => {
    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      handler.groupRequestParticipantsList("+5511999", "group@g.us");
      expect(mockGroupRequestParticipantsList).toHaveBeenCalledWith(
        "group@g.us",
      );
    });
  });

  describe("#groupRequestParticipantsUpdate", () => {
    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      handler.groupRequestParticipantsUpdate(
        "+5511999",
        "group@g.us",
        ["user@s.whatsapp.net"],
        "approve",
      );
      expect(mockGroupRequestParticipantsUpdate).toHaveBeenCalledWith(
        "group@g.us",
        ["user@s.whatsapp.net"],
        "approve",
      );
    });
  });

  describe("#groupInviteCode", () => {
    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      handler.groupInviteCode("+5511999", "group@g.us");
      expect(mockGroupInviteCode).toHaveBeenCalledWith("group@g.us");
    });
  });

  describe("#groupRevokeInvite", () => {
    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      handler.groupRevokeInvite("+5511999", "group@g.us");
      expect(mockGroupRevokeInvite).toHaveBeenCalledWith("group@g.us");
    });
  });

  describe("#groupAcceptInvite", () => {
    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      handler.groupAcceptInvite("+5511999", "invite-code");
      expect(mockGroupAcceptInvite).toHaveBeenCalledWith("invite-code");
    });
  });

  describe("#groupRevokeInviteV4", () => {
    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      handler.groupRevokeInviteV4(
        "+5511999",
        "group@g.us",
        "inviter@s.whatsapp.net",
      );
      expect(mockGroupRevokeInviteV4).toHaveBeenCalledWith(
        "group@g.us",
        "inviter@s.whatsapp.net",
      );
    });
  });

  describe("#groupAcceptInviteV4", () => {
    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      handler.groupAcceptInviteV4("+5511999", "group@g.us", {
        inviteCode: "code",
        inviteExpiration: 123,
      } as any);
      expect(mockGroupAcceptInviteV4).toHaveBeenCalledWith("group@g.us", {
        inviteCode: "code",
        inviteExpiration: 123,
      });
    });
  });

  describe("#groupGetInviteInfo", () => {
    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      handler.groupGetInviteInfo("+5511999", "invite-code");
      expect(mockGroupGetInviteInfo).toHaveBeenCalledWith("invite-code");
    });
  });

  describe("#groupToggleEphemeral", () => {
    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      handler.groupToggleEphemeral("+5511999", "group@g.us", 86400);
      expect(mockGroupToggleEphemeral).toHaveBeenCalledWith(
        "group@g.us",
        86400,
      );
    });
  });

  describe("#groupSettingUpdate", () => {
    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      handler.groupSettingUpdate("+5511999", "group@g.us", "announcement");
      expect(mockGroupSettingUpdate).toHaveBeenCalledWith(
        "group@g.us",
        "announcement",
      );
    });
  });

  describe("#groupMemberAddMode", () => {
    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      handler.groupMemberAddMode("+5511999", "group@g.us", "all_member_add");
      expect(mockGroupMemberAddMode).toHaveBeenCalledWith(
        "group@g.us",
        "all_member_add",
      );
    });
  });

  describe("#groupJoinApprovalMode", () => {
    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      handler.groupJoinApprovalMode("+5511999", "group@g.us", "on");
      expect(mockGroupJoinApprovalMode).toHaveBeenCalledWith(
        "group@g.us",
        "on",
      );
    });
  });

  describe("#groupFetchAllParticipating", () => {
    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      handler.groupFetchAllParticipating("+5511999");
      expect(mockGroupFetchAllParticipating).toHaveBeenCalled();
    });
  });

  describe("#presenceSubscribe", () => {
    it("throws BaileysNotConnectedError when connection does not exist", () => {
      expect(() =>
        handler.presenceSubscribe("+5511999", ["user@s.whatsapp.net"]),
      ).toThrow(BaileysNotConnectedError);
    });

    it("delegates to the connection", async () => {
      await handler.connect("+5511999", defaultOptions);
      mockPresenceSubscribe.mockClear();
      handler.presenceSubscribe("+5511999", [
        "user1@s.whatsapp.net",
        "user2@s.whatsapp.net",
      ]);
      expect(mockPresenceSubscribe).toHaveBeenCalledWith([
        "user1@s.whatsapp.net",
        "user2@s.whatsapp.net",
      ]);
    });
  });
});
