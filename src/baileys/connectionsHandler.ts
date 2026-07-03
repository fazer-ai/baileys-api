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
import { getRedisAuthMetadata } from "@/baileys/redisAuthState";
import type {
  BaileysConnectionOptions,
  FetchMessageHistoryOptions,
  MessageKeyWithId,
  SendReceiptsOptions,
} from "@/baileys/types";
import { errorToString } from "@/helpers/errorToString";
import logger from "@/lib/logger";

type ConnectionFactory = (
  phoneNumber: string,
  options: BaileysConnectionOptions,
) => BaileysConnection;

export class BaileysConnectionsHandler {
  private connections: Record<string, BaileysConnection> = {};
  private inFlightOps: Record<string, Promise<void>> = {};
  // Discarded connections whose webhook deliveries (including retries) are
  // still running. They left `connections` already, but the shutdown drain
  // must keep seeing their in-flight count until it reaches zero.
  private drainingWebhooks = new Set<BaileysConnection>();
  private createConnection: ConnectionFactory;

  constructor(createConnection?: ConnectionFactory) {
    this.createConnection =
      createConnection || ((phone, opts) => new BaileysConnection(phone, opts));
  }

  hasConnection(phoneNumber: string): boolean {
    return Boolean(this.connections[phoneNumber]);
  }

  getActivePhoneNumbers(): string[] {
    return Object.keys(this.connections);
  }

  get size(): number {
    return Object.keys(this.connections).length;
  }

  inFlightWebhookCount(): number {
    for (const connection of this.drainingWebhooks) {
      if (connection.inFlightWebhooks === 0) {
        this.drainingWebhooks.delete(connection);
      }
    }
    let sum = 0;
    for (const connection of Object.values(this.connections)) {
      sum += connection.inFlightWebhooks;
    }
    for (const connection of this.drainingWebhooks) {
      sum += connection.inFlightWebhooks;
    }
    return sum;
  }

  // Activity snapshot used by the coordinator to prefer idle connections
  // when shedding load (rebalance victim selection, shutdown ordering).
  connectionActivity(phoneNumber: string): {
    inFlightWebhooks: number;
    lastTrafficAt: number | null;
  } | null {
    const connection = this.connections[phoneNumber];
    if (!connection) {
      return null;
    }
    return {
      inFlightWebhooks: connection.inFlightWebhooks,
      lastTrafficAt: connection.lastTrafficAt,
    };
  }

  // Tears down the local socket WITHOUT touching the Redis auth state, so the
  // identity can be picked up elsewhere. Used by the cluster coordinator for
  // self-fencing (lease owned by another instance) and graceful handoff.
  // Serialized through inFlightOps so it cannot interleave with a concurrent
  // connect/logout for the same number.
  async discardConnection(phoneNumber: string): Promise<void> {
    await this.withInFlightOp(phoneNumber, async () => {
      const connection = this.connections[phoneNumber];
      if (!connection) {
        return;
      }
      connection.discard();
      delete this.connections[phoneNumber];
      if (connection.inFlightWebhooks > 0) {
        this.drainingWebhooks.add(connection);
      }
    });
  }

  // Drains any in-flight op for `phoneNumber`, reserves a fresh slot
  // synchronously, and runs `fn` inside it. Serializes concurrent
  // connect/logout calls for the same number so we never have two parallel
  // sockets with the same identity (which the WhatsApp server kicks with
  // conflict/replaced). The internal drain is defense-in-depth so callers
  // can't accidentally bypass the lock by skipping a prior drain.
  private async withInFlightOp<T>(
    phoneNumber: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    // Loop because multiple callers may have been parked on the same slot;
    // when one resolves, all wake — only the first to assign synchronously
    // below wins the slot. Single-threaded JS makes this safe: nothing can
    // run between the while-exit and the synchronous slot assignment.
    while (this.inFlightOps[phoneNumber]) {
      await this.inFlightOps[phoneNumber].catch(() => {});
    }
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
        requestLogout: () => {
          // Wrong-phone teardown must serialize through inFlightOps so it
          // can't race a concurrent connect/logout/discard for this number
          // (issue #313). Mirror onConnectionClose's identity check: a
          // replacement may already hold the slot, and only the instance that
          // saw the wrong number should be torn down — logout() clears the
          // shared auth state, which we must not wipe out from under a live
          // replacement.
          void this.withInFlightOp(phoneNumber, async () => {
            if (this.connections[phoneNumber] !== connection) {
              return;
            }
            await connection.logout();
            delete this.connections[phoneNumber];
          }).catch((error) => {
            logger.error(
              "[%s] [requestLogout] %s",
              phoneNumber,
              errorToString(error),
            );
          });
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
    const { forceRestart, ...connectOptions } = options;
    for (;;) {
      while (this.inFlightOps[phoneNumber]) {
        await this.inFlightOps[phoneNumber].catch(() => {});
      }

      const existing = this.connections[phoneNumber];

      // A just-seeded import/takeover must run on a fresh socket: an existing one
      // holds stale in-memory creds and would ignore the transplanted session
      // (e.g. a QR socket keeps emitting QRs). Discard it, then spawn anew.
      if (existing && forceRestart) {
        existing.discard();
        delete this.connections[phoneNumber];
        // Keep shutdown-drain accounting exactly like discardConnection: a
        // discarded connection with pending webhook deliveries (e.g. a QR
        // socket mid-retry) must stay counted so a graceful shutdown waits for
        // them instead of exiting mid-delivery.
        if (existing.inFlightWebhooks > 0) {
          this.drainingWebhooks.add(existing);
        }
        await this.spawnConnection(phoneNumber, connectOptions);
        return;
      }

      if (!existing) {
        await this.spawnConnection(phoneNumber, connectOptions);
        return;
      }

      await existing.updateOptions(connectOptions);
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

  getReachoutTimelock(phoneNumber: string) {
    return this.getConnection(phoneNumber).getReachoutTimelock();
  }

  getNewChatMessageCap(phoneNumber: string) {
    return this.getConnection(phoneNumber).getNewChatMessageCap();
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
    // `withInFlightOp` drains any pending connect/logout for the same
    // number before reserving its slot, so a logout that arrives while
    // a connect is mid-spawn parks until the spawn settles.
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
