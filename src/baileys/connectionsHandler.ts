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
  BaileysConnectionForbiddenError,
  BaileysNotConnectedError,
} from "@/baileys/connection";
import {
  getRedisAuthMetadata,
  getRedisSavedAuthStateIds,
} from "@/baileys/redisAuthState";
import type {
  BaileysConnectionOptions,
  FetchMessageHistoryOptions,
  MessageKeyWithId,
  SendReceiptsOptions,
} from "@/baileys/types";
import { asyncSleep } from "@/helpers/asyncSleep";
import logger from "@/lib/logger";

type ConnectionFactory = (
  phoneNumber: string,
  options: BaileysConnectionOptions,
) => BaileysConnection;

export class BaileysConnectionsHandler {
  private connections: Record<string, BaileysConnection> = {};
  private inFlightOps: Record<string, Promise<void>> = {};
  private createConnection: ConnectionFactory;

  constructor(createConnection?: ConnectionFactory) {
    this.createConnection =
      createConnection || ((phone, opts) => new BaileysConnection(phone, opts));
  }

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
          await this.spawnConnection(id, {
            isReconnect: true,
            ...metadata,
          });
        }),
      );
    }
  }

  // Reserves the inFlightOps slot for `phoneNumber` synchronously and runs
  // `fn` inside it. Serializes concurrent connect/logout calls for the same
  // number so we never have two parallel sockets with the same identity
  // (which the WhatsApp server kicks with conflict/replaced).
  private async withInFlightOp<T>(
    phoneNumber: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    let resolveSlot: () => void = () => {};
    const slot = new Promise<void>((res) => {
      resolveSlot = res;
    });
    this.inFlightOps[phoneNumber] = slot;
    try {
      return await fn();
    } finally {
      if (this.inFlightOps[phoneNumber] === slot) {
        delete this.inFlightOps[phoneNumber];
      }
      resolveSlot();
    }
  }

  private async spawnConnection(
    phoneNumber: string,
    options: BaileysConnectionOptions,
  ) {
    await this.withInFlightOp(phoneNumber, async () => {
      // If another connection is already registered for this number, discard
      // it before overwriting. Otherwise its socket would stay alive,
      // unreachable from `connections` but still racing on our identity.
      // Guards a re-entrant reconnectFromAuthStore or any future caller
      // that ends up spawning twice for the same number.
      const previous = this.connections[phoneNumber];
      if (previous) {
        previous.discard();
      }
      const connection = this.createConnection(phoneNumber, {
        ...options,
        onConnectionClose: () => {
          // Only clear the slot if it still points at this connection — a
          // newer connection may have replaced this one (e.g. via the
          // BaileysNotConnectedError recovery path in `connect`).
          if (this.connections[phoneNumber] === connection) {
            delete this.connections[phoneNumber];
          }
          logger.debug(
            "Now tracking %d connections",
            Object.keys(this.connections).length,
          );
          options.onConnectionClose?.();
        },
      });
      this.connections[phoneNumber] = connection;
      await connection.connect();
    });
  }

  async connect(phoneNumber: string, options: BaileysConnectionOptions) {
    // Loops because every decision must be re-validated after an await:
    //   1. Drain any in-flight connect for this number (multiple callers can
    //      have parked on the same slot).
    //   2. If a connection is registered, try to reuse it via
    //      sendPresenceUpdate. If that throws BaileysNotConnectedError, the
    //      socket died — evict only if it is still the entry we observed,
    //      then restart the decision instead of unconditionally spawning a
    //      replacement (two callers hitting the same stale connection would
    //      otherwise both spawn parallel sockets with the same identity).
    //   3. Otherwise spawn a new connection.
    for (;;) {
      while (this.inFlightOps[phoneNumber]) {
        await this.inFlightOps[phoneNumber].catch(() => {});
      }

      const existing = this.connections[phoneNumber];
      if (!existing) {
        await this.spawnConnection(phoneNumber, options);
        return;
      }

      existing.updateOptions(options);
      try {
        // NOTE: This triggers a `connection.update` event.
        await existing.sendPresenceUpdate("available");
        return;
      } catch (error) {
        if (!(error instanceof BaileysNotConnectedError)) {
          throw error;
        }
        if (this.connections[phoneNumber] === existing) {
          // Discard the stale connection synchronously so any pending
          // reconnect (e.g. after a connectionReplaced backoff) cannot
          // resurrect a parallel socket once we spawn the replacement.
          existing.discard();
          delete this.connections[phoneNumber];
        }
        logger.debug(
          "Handled inconsistent connection state for %s",
          phoneNumber,
        );
      }
    }
  }

  async verifyConnectionAccess(phoneNumber: string, apiKeyHash: string | null) {
    const connection = this.connections[phoneNumber];
    let ownerHash: string | null | undefined;
    if (connection) {
      ownerHash = connection.apiKeyHash;
    } else {
      const metadata = await getRedisAuthMetadata<{
        apiKeyHash?: string | null;
      }>(phoneNumber);
      ownerHash = metadata?.apiKeyHash;
    }
    if (ownerHash && apiKeyHash && ownerHash !== apiKeyHash) {
      throw new BaileysConnectionForbiddenError();
    }
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

  presenceSubscribe(phoneNumber: string, jids: string[]) {
    return this.getConnection(phoneNumber).presenceSubscribe(jids);
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

  updateProfilePicture(phoneNumber: string, jid: string, image: Buffer) {
    return this.getConnection(phoneNumber).updateProfilePicture(jid, image);
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
    // Park behind any in-flight connect/logout for this number so we don't
    // race a freshly spawned socket (e.g. from reconnectFromAuthStore on
    // boot) that hasn't registered itself in `connections` yet.
    while (this.inFlightOps[phoneNumber]) {
      await this.inFlightOps[phoneNumber].catch(() => {});
    }
    await this.withInFlightOp(phoneNumber, async () => {
      await this.getConnection(phoneNumber).logout();
      delete this.connections[phoneNumber];
      logger.debug(
        "Now tracking %d connections",
        Object.keys(this.connections).length,
      );
    });
  }

  async logoutAll() {
    // Drain in-flight ops in a loop, not a single snapshot — a spawn that
    // started after our first await would otherwise survive the bulk logout
    // with a live socket, leaving an orphan authenticated with our identity.
    while (Object.keys(this.inFlightOps).length > 0) {
      await Promise.allSettled(Object.values(this.inFlightOps));
    }
    const connections = Object.values(this.connections);
    await Promise.allSettled(connections.map((c) => c.logout()));
    this.connections = {};
  }
}
