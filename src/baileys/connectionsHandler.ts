import type {
  AnyMessageContent,
  ChatModification,
  ParticipantAction,
  proto,
  WAMessage,
  WAMessageKey,
  WAPresence,
} from "@whiskeysockets/baileys";
import {
  BaileysConnection,
  BaileysNotConnectedError,
} from "@/baileys/connection";
import { getRedisSavedAuthStateIds } from "@/baileys/redisAuthState";
import type {
  BaileysConnectionOptions,
  FetchMessageHistoryOptions,
  MessageKeyWithId,
  SendReceiptsOptions,
} from "@/baileys/types";
import { asyncSleep } from "@/helpers/asyncSleep";
import logger from "@/lib/logger";

export class BaileysConnectionsHandler {
  private connections: Record<string, BaileysConnection> = {};

  async reconnectFromAuthStore() {
    const savedConnections =
      await getRedisSavedAuthStateIds<
        Omit<BaileysConnectionOptions, "phoneNumber" | "onConnectionClose">
      >();

    if (savedConnections.length === 0) {
      logger.info("No saved connections to reconnect");
      return;
    }

    logger.info(
      "Reconnecting %d connections from auth store %o",
      savedConnections.length,
      savedConnections.map(({ id }) => id),
    );

    const CONCURRENCY = 5;
    for (let i = 0; i < savedConnections.length; i += CONCURRENCY) {
      const chunk = savedConnections.slice(i, i + CONCURRENCY);
      await Promise.allSettled(
        chunk.map(async ({ id, metadata }) => {
          await asyncSleep(Math.floor(Math.random() * 100));
          const connection = new BaileysConnection(id, {
            onConnectionClose: () => {
              delete this.connections[id];
              logger.debug(
                "Now tracking %d connections",
                Object.keys(this.connections).length,
              );
            },
            isReconnect: true,
            ...metadata,
          });
          this.connections[id] = connection;
          await connection.connect();
        }),
      );
    }
  }

  async connect(phoneNumber: string, options: BaileysConnectionOptions) {
    if (this.connections[phoneNumber]) {
      this.connections[phoneNumber].updateOptions(options);
      try {
        // NOTE: This triggers a `connection.update` event.
        await this.connections[phoneNumber].sendPresenceUpdate("available");
        return;
      } catch (error) {
        if (!(error instanceof BaileysNotConnectedError)) {
          throw error;
        }
        delete this.connections[phoneNumber];
        logger.debug(
          "Handled inconsistent connection state for %s",
          phoneNumber,
        );
      }
    }

    const connection = new BaileysConnection(phoneNumber, {
      ...options,
      onConnectionClose: () => {
        delete this.connections[phoneNumber];
        options.onConnectionClose?.();
      },
    });
    await connection.connect();
    this.connections[phoneNumber] = connection;
    logger.debug(
      "Now tracking %d connections",
      Object.keys(this.connections).length,
    );
  }

  private getConnection(phoneNumber: string) {
    const connection = this.connections[phoneNumber];
    if (!connection) {
      throw new BaileysNotConnectedError();
    }
    return connection;
  }

  sendPresenceUpdate(
    phoneNumber: string,
    { type, toJid }: { type: WAPresence; toJid?: string | undefined },
  ) {
    return this.getConnection(phoneNumber).sendPresenceUpdate(type, toJid);
  }

  sendMessage(
    phoneNumber: string,
    {
      jid,
      messageContent,
      quoted,
    }: {
      jid: string;
      messageContent: AnyMessageContent;
      quoted?: WAMessage;
    },
  ) {
    return this.getConnection(phoneNumber).sendMessage(jid, messageContent, {
      quoted,
    });
  }

  readMessages(phoneNumber: string, keys: proto.IMessageKey[]) {
    return this.getConnection(phoneNumber).readMessages(keys);
  }

  chatModify(phoneNumber: string, mod: ChatModification, jid: string) {
    return this.getConnection(phoneNumber).chatModify(mod, jid);
  }

  fetchMessageHistory(
    phoneNumber: string,
    { count, oldestMsgKey, oldestMsgTimestamp }: FetchMessageHistoryOptions,
  ) {
    return this.getConnection(phoneNumber).fetchMessageHistory(
      count,
      oldestMsgKey,
      oldestMsgTimestamp,
    );
  }

  sendReceipts(phoneNumber: string, { keys, type }: SendReceiptsOptions) {
    return this.getConnection(phoneNumber).sendReceipts(keys, type);
  }

  deleteMessage(
    phoneNumber: string,
    { jid, key }: { jid: string; key: MessageKeyWithId },
  ) {
    return this.getConnection(phoneNumber).deleteMessage(jid, key);
  }

  editMessage(
    phoneNumber: string,
    {
      jid,
      key,
      messageContent,
    }: {
      jid: string;
      key: proto.IMessageKey;
      messageContent: AnyMessageContent;
    },
  ) {
    return this.getConnection(phoneNumber).editMessage(
      jid,
      key,
      messageContent,
    );
  }

  profilePictureUrl(
    phoneNumber: string,
    jid: string,
    type?: "preview" | "image",
  ) {
    return this.getConnection(phoneNumber).profilePictureUrl(jid, type);
  }

  onWhatsApp(phoneNumber: string, jids: string[]) {
    return this.getConnection(phoneNumber).onWhatsApp(jids);
  }

  getBusinessProfile(phoneNumber: string, jid: string) {
    return this.getConnection(phoneNumber).getBusinessProfile(jid);
  }

  groupMetadata(phoneNumber: string, jid: string) {
    return this.getConnection(phoneNumber).groupMetadata(jid);
  }

  groupParticipants(
    phoneNumber: string,
    jid: string,
    participants: string[],
    action: ParticipantAction,
  ) {
    return this.getConnection(phoneNumber).groupParticipants(
      jid,
      participants,
      action,
    );
  }

  groupUpdateSubject(phoneNumber: string, jid: string, subject: string) {
    return this.getConnection(phoneNumber).groupUpdateSubject(jid, subject);
  }

  groupUpdateDescription(
    phoneNumber: string,
    jid: string,
    description?: string,
  ) {
    return this.getConnection(phoneNumber).groupUpdateDescription(
      jid,
      description,
    );
  }

  groupCreate(phoneNumber: string, subject: string, participants: string[]) {
    return this.getConnection(phoneNumber).groupCreate(subject, participants);
  }

  groupLeave(phoneNumber: string, jid: string) {
    return this.getConnection(phoneNumber).groupLeave(jid);
  }

  groupRequestParticipantsList(phoneNumber: string, jid: string) {
    return this.getConnection(phoneNumber).groupRequestParticipantsList(jid);
  }

  groupRequestParticipantsUpdate(
    phoneNumber: string,
    jid: string,
    participants: string[],
    action: "approve" | "reject",
  ) {
    return this.getConnection(phoneNumber).groupRequestParticipantsUpdate(
      jid,
      participants,
      action,
    );
  }

  groupInviteCode(phoneNumber: string, jid: string) {
    return this.getConnection(phoneNumber).groupInviteCode(jid);
  }

  groupRevokeInvite(phoneNumber: string, jid: string) {
    return this.getConnection(phoneNumber).groupRevokeInvite(jid);
  }

  groupAcceptInvite(phoneNumber: string, code: string) {
    return this.getConnection(phoneNumber).groupAcceptInvite(code);
  }

  groupRevokeInviteV4(
    phoneNumber: string,
    groupJid: string,
    invitedJid: string,
  ) {
    return this.getConnection(phoneNumber).groupRevokeInviteV4(
      groupJid,
      invitedJid,
    );
  }

  groupAcceptInviteV4(
    phoneNumber: string,
    key: string | WAMessageKey,
    inviteMessage: proto.Message.IGroupInviteMessage,
  ) {
    return this.getConnection(phoneNumber).groupAcceptInviteV4(
      key,
      inviteMessage,
    );
  }

  groupGetInviteInfo(phoneNumber: string, code: string) {
    return this.getConnection(phoneNumber).groupGetInviteInfo(code);
  }

  groupToggleEphemeral(
    phoneNumber: string,
    jid: string,
    ephemeralExpiration: number,
  ) {
    return this.getConnection(phoneNumber).groupToggleEphemeral(
      jid,
      ephemeralExpiration,
    );
  }

  groupSettingUpdate(
    phoneNumber: string,
    jid: string,
    setting: "announcement" | "not_announcement" | "locked" | "unlocked",
  ) {
    return this.getConnection(phoneNumber).groupSettingUpdate(jid, setting);
  }

  groupMemberAddMode(
    phoneNumber: string,
    jid: string,
    mode: "admin_add" | "all_member_add",
  ) {
    return this.getConnection(phoneNumber).groupMemberAddMode(jid, mode);
  }

  groupJoinApprovalMode(phoneNumber: string, jid: string, mode: "on" | "off") {
    return this.getConnection(phoneNumber).groupJoinApprovalMode(jid, mode);
  }

  groupFetchAllParticipating(phoneNumber: string) {
    return this.getConnection(phoneNumber).groupFetchAllParticipating();
  }

  async logout(phoneNumber: string) {
    await this.getConnection(phoneNumber).logout();
    delete this.connections[phoneNumber];
    logger.debug(
      "Now tracking %d connections",
      Object.keys(this.connections).length,
    );
  }

  async logoutAll() {
    const connections = Object.values(this.connections);
    await Promise.allSettled(connections.map((c) => c.logout()));
    this.connections = {};
  }
}
