import { beforeEach, describe, expect, it, mock } from "bun:test";

// Logger and asyncSleep are mocked in preload.ts

// Track BaileysConnection instances
const mockConnectionInstances: Map<string, any> = new Map();

const mockConnect = mock(async function (this: any) {});
const mockLogout = mock(async function (this: any) {});
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
const mockUpdateOptions = mock(function (this: any) {});
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

class MockBaileysConnection {
  phoneNumber: string;
  options: any;
  _apiKeyHash: string | null;

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
}

mock.module("@/baileys/connection", () => ({
  BaileysConnection: MockBaileysConnection,
  BaileysNotConnectedError: class BaileysNotConnectedError extends Error {
    constructor() {
      super("Phone number not connected");
    }
  },
  BaileysConnectionForbiddenError: class BaileysConnectionForbiddenError extends Error {
    constructor() {
      super("Connection not owned by this API key");
    }
  },
}));

mock.module("@/baileys/redisAuthState", () => ({
  getRedisSavedAuthStateIds: mock(async () => []),
}));

import {
  BaileysConnectionForbiddenError,
  BaileysNotConnectedError,
} from "@/baileys/connection";
import { getRedisSavedAuthStateIds } from "@/baileys/redisAuthState";
import { BaileysConnectionsHandler } from "./connectionsHandler";

describe("BaileysConnectionsHandler", () => {
  let handler: BaileysConnectionsHandler;

  const defaultOptions = {
    webhookUrl: "https://example.com/webhook",
    webhookVerifyToken: "test-token",
  };

  beforeEach(() => {
    handler = new BaileysConnectionsHandler();
    mockConnectionInstances.clear();
    mockConnect.mockClear();
    mockLogout.mockClear();
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
  });

  describe("#reconnectFromAuthStore", () => {
    it("does nothing when no saved connections exist", async () => {
      (
        getRedisSavedAuthStateIds as ReturnType<typeof mock>
      ).mockResolvedValueOnce([]);
      await handler.reconnectFromAuthStore();
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it("reconnects saved connections", async () => {
      (
        getRedisSavedAuthStateIds as ReturnType<typeof mock>
      ).mockResolvedValueOnce([
        {
          id: "+5511999",
          metadata: {
            webhookUrl: "https://hook1.com",
            webhookVerifyToken: "t1",
          },
        },
        {
          id: "+5521888",
          metadata: {
            webhookUrl: "https://hook2.com",
            webhookVerifyToken: "t2",
          },
        },
      ]);

      await handler.reconnectFromAuthStore();
      expect(mockConnect).toHaveBeenCalledTimes(2);
      expect(mockConnectionInstances.size).toBe(2);
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

    it("handles inconsistent connection state when sendPresenceUpdate throws BaileysNotConnectedError", async () => {
      await handler.connect("+5511999", defaultOptions);
      mockConnect.mockClear();
      mockSendPresenceUpdate.mockRejectedValueOnce(
        new BaileysNotConnectedError(),
      );

      await handler.connect("+5511999", defaultOptions);
      // Should create a new connection
      expect(mockConnect).toHaveBeenCalledTimes(1);
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
  });

  describe("#verifyConnectionAccess", () => {
    it("does nothing when no connection exists", () => {
      // Should not throw
      handler.verifyConnectionAccess("+5511999", "some-hash");
    });

    it("does nothing when connection has no apiKeyHash", async () => {
      await handler.connect("+5511999", defaultOptions);
      // Should not throw
      handler.verifyConnectionAccess("+5511999", "some-hash");
    });

    it("does nothing when hashes match", async () => {
      await handler.connect("+5511999", {
        ...defaultOptions,
        apiKeyHash: "matching-hash",
      });
      // Should not throw
      handler.verifyConnectionAccess("+5511999", "matching-hash");
    });

    it("throws BaileysConnectionForbiddenError when hashes don't match", async () => {
      await handler.connect("+5511999", {
        ...defaultOptions,
        apiKeyHash: "hash-a",
      });
      expect(() =>
        handler.verifyConnectionAccess("+5511999", "hash-b"),
      ).toThrow(BaileysConnectionForbiddenError);
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
});
