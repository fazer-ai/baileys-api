import type { Boom } from "@hapi/boom";
import makeWASocket, {
  type AnyMessageContent,
  type AuthenticationState,
  type BaileysEventMap,
  Browsers,
  type ChatModification,
  type ConnectionState,
  DisconnectReason,
  isJidGroup,
  type MessageReceiptType,
  makeCacheableSignalKeyStore,
  type ParticipantAction,
  type proto,
  type UserFacingSocketConfig,
  type WAConnectionState,
  type WAMessage,
  type WAMessageKey,
  WAMessageStatus,
  type WAPresence,
} from "@whiskeysockets/baileys";
import { toDataURL } from "qrcode";
import { downloadMediaFromMessages } from "@/baileys/helpers/downloadMediaFromMessages";
import { fetchBaileysClientVersion } from "@/baileys/helpers/fetchBaileysClientVersion";
import { normalizeBrazilPhoneNumber } from "@/baileys/helpers/normalizeBrazilPhoneNumber";
import { preprocessAudio } from "@/baileys/helpers/preprocessAudio";
import { shouldIgnoreJid } from "@/baileys/helpers/shouldIgnoreJid";
import {
  advanceImportCandidate,
  clearImportCandidates,
  useRedisAuthState,
  writeAuthMetadata,
} from "@/baileys/redisAuthState";
import type {
  BaileysConnectionOptions,
  BaileysConnectionWebhookPayload,
  MessageKeyWithId,
} from "@/baileys/types";
import { instanceId } from "@/cluster/identity";
import { getLease } from "@/cluster/leaseStore";
import config from "@/config";
import { asyncSleep } from "@/helpers/asyncSleep";
import { errorToString } from "@/helpers/errorToString";
import logger, { baileysLogger, deepSanitizeObject } from "@/lib/logger";

// `connectionReplaced` (440 conflict/replaced) usually clears on the next attempt,
// so default behavior is a normal reconnect. When the same disconnect repeats
// rapidly it indicates another session is competing for this slot and the tight
// retry only feeds the loop, so after the threshold we add a backoff.
const CONNECTION_REPLACED_LOOP_WINDOW_MS = 30_000;
const CONNECTION_REPLACED_LOOP_THRESHOLD = 5;
const CONNECTION_REPLACED_BACKOFF_MS = 30_000;

// Per-message NACK code WhatsApp returns when an outgoing message hits the
// reach-out time-lock ("account restricted", error 463). It surfaces to us as
// a messages.update with status ERROR carrying this code in
// messageStubParameters. See messages-recv.js in @whiskeysockets/baileys.
const MESSAGE_ACCOUNT_RESTRICTION_CODE = "463";
// On a 463 we actively query the authoritative restriction state from
// WhatsApp (fetchAccountReachoutTimelock), which emits a connection.update
// carrying reachoutTimeLock. A burst of 463s (mass cold outreach) would
// otherwise fire one query per failed message; debounce so we query at most
// once per window per connection.
const REACHOUT_TIMELOCK_REFETCH_WINDOW_MS = 60_000;

export class BaileysNotConnectedError extends Error {
  constructor() {
    super("Phone number not connected");
  }
}

export class BaileysConnectionForbiddenError extends Error {
  constructor() {
    super("Connection not owned by this API key");
  }
}

export class BaileysConnection {
  private LOGGER_OMIT_KEYS: ReadonlyArray<string> = [
    "qr",
    "qrDataUrl",
    "fileSha256",
    "jpegThumbnail",
    "fileEncSha256",
    "scansSidecar",
    "midQualityFileSha256",
    "mediaKey",
    "senderKeyHash",
    "recipientKeyHash",
    "messageSecret",
    "thumbnailSha256",
    "thumbnailEncSha256",
    "appStateSyncKeyShare",
    "initialHistBootstrapInlinePayload",
  ];
  private ALL_BAILEYS_SOCKET_EVENTS: ReadonlyArray<keyof BaileysEventMap> = [
    "connection.update",
    "creds.update",
    "messaging-history.set",
    "messaging-history.status",
    "chats.upsert",
    "chats.update",
    "chats.lock",
    "lid-mapping.update",
    "chats.delete",
    "presence.update",
    "contacts.upsert",
    "contacts.update",
    "messages.delete",
    "messages.update",
    "messages.media-update",
    "messages.upsert",
    "messages.reaction",
    "message-receipt.update",
    "message-capping.update",
    "groups.upsert",
    "groups.update",
    "group-participants.update",
    "group.join-request",
    "group.member-tag.update",
    "blocklist.set",
    "blocklist.update",
    "call",
    "labels.edit",
    "labels.association",
    "newsletter.reaction",
    "newsletter.view",
    "newsletter-participants.update",
    "newsletter-settings.update",
    "settings.update",
  ];

  private phoneNumber: string;
  private clientName: string;
  private webhookUrl: string;
  private webhookVerifyToken: string;
  private isReconnect: boolean;
  private includeMedia: boolean;
  private syncFullHistory: boolean;
  private onConnectionClose: (() => void) | null;
  private requestLogout: (() => void) | null;
  private socket: ReturnType<typeof makeWASocket> | null;
  private clearAuthState: AuthenticationState["keys"]["clear"] | null;
  private clearOnlinePresenceTimeout: ReturnType<typeof setTimeout> | null =
    null;
  private reconnectCount = 0;
  private connectionReplacedTimestamps: number[] = [];
  private isDiscarded = false;
  // Tracks whether this connection ever reached `open`. Imported sessions cycle
  // Noise candidates only while they have never opened; a close after opening
  // is a normal disconnect, not a wrong-key handshake failure.
  private hasOpened = false;
  private _inFlightWebhooks = 0;
  private leaseEpoch: number | null = null;
  // Monotonic timestamp of the last message-level traffic (received message,
  // outgoing send, receipt update). null = no traffic since this connection
  // object was created. Drives idle-aware handoff in the coordinator.
  private _lastTrafficAt: number | null = null;
  private groupsEnabled: boolean;
  private autoPresenceSubscribe: boolean;
  private _apiKeyHash: string | null;
  private groupActivityMap: Map<
    string,
    { unreadCount: number; lastMessageAt: number }
  > = new Map();
  private groupActivityInterval: ReturnType<typeof setInterval> | null = null;
  // Debounce bookkeeping for the active reach-out time-lock query triggered on
  // a 463 (see handleMessagesUpdate / fetchReachoutTimelockOn463).
  private reachoutTimelockFetchInFlight = false;
  private lastReachoutTimelockFetchAt = 0;

  constructor(phoneNumber: string, options: BaileysConnectionOptions) {
    this.phoneNumber = phoneNumber;
    this.clientName = options.clientName || "Chrome";
    this.webhookUrl = options.webhookUrl;
    this.webhookVerifyToken = options.webhookVerifyToken;
    this.onConnectionClose = options.onConnectionClose || null;
    this.requestLogout = options.requestLogout ?? null;
    this.socket = null;
    this.clearAuthState = null;
    this.isReconnect = !!options.isReconnect;
    // TODO(v2): Change default to false.
    this.includeMedia = options.includeMedia ?? true;
    this.syncFullHistory = options.syncFullHistory ?? false;
    this.groupsEnabled = options.groupsEnabled ?? true;
    this.autoPresenceSubscribe = options.autoPresenceSubscribe ?? false;
    this._apiKeyHash = options.apiKeyHash ?? null;
    this.leaseEpoch = options.leaseEpoch ?? null;
  }

  get apiKeyHash(): string | null {
    return this._apiKeyHash;
  }

  get inFlightWebhooks(): number {
    return this._inFlightWebhooks;
  }

  get lastTrafficAt(): number | null {
    return this._lastTrafficAt;
  }

  private markTraffic() {
    this._lastTrafficAt = performance.now();
  }

  // biome-ignore lint/suspicious/noExplicitAny: Typing this wrapper is not trivial.
  private withErrorHandling<T extends (...args: any[]) => any>(
    handlerName: string,
    handler: T,
  ): (...args: Parameters<T>) => Promise<void> {
    return async (...args: Parameters<T>) => {
      try {
        await handler.apply(this, args);
      } catch (error) {
        logger.error(
          "[%s] [%s] Error: %s",
          this.phoneNumber,
          handlerName,
          errorToString(error),
        );
      }
    };
  }

  async updateOptions(options: BaileysConnectionOptions) {
    this.clientName = options.clientName || "Chrome";
    this.webhookUrl = options.webhookUrl;
    this.webhookVerifyToken = options.webhookVerifyToken;
    this.includeMedia = options.includeMedia ?? true;
    this.syncFullHistory = options.syncFullHistory ?? false;

    const prevGroupsEnabled = this.groupsEnabled;
    this.groupsEnabled = options.groupsEnabled ?? true;
    if (prevGroupsEnabled !== this.groupsEnabled && this.socket) {
      if (this.groupsEnabled) {
        this.stopGroupActivityFlush();
      } else {
        this.startGroupActivityFlush();
      }
    }

    this.autoPresenceSubscribe = options.autoPresenceSubscribe ?? false;
    this._apiKeyHash = options.apiKeyHash ?? this._apiKeyHash;
    // A reused connection may have been re-leased under a newer epoch (e.g. a
    // force-acquire on POST /connections); stale epochs would get the
    // webhooks discarded by the client.
    if (options.leaseEpoch !== undefined) {
      this.leaseEpoch = options.leaseEpoch;
    }
    await this.persistMetadata();
  }

  private async persistMetadata() {
    // Owner-fenced: updateOptions can run on a connection whose lease has
    // since moved, and an unfenced write here would overwrite the new
    // owner's metadata (see writeAuthMetadata).
    await writeAuthMetadata(this.phoneNumber, {
      clientName: this.clientName,
      webhookUrl: this.webhookUrl,
      webhookVerifyToken: this.webhookVerifyToken,
      includeMedia: this.includeMedia,
      syncFullHistory: this.syncFullHistory,
      groupsEnabled: this.groupsEnabled,
      autoPresenceSubscribe: this.autoPresenceSubscribe,
      apiKeyHash: this._apiKeyHash,
    });
  }

  async connect() {
    if (this.isDiscarded || this.socket) {
      return;
    }

    const { state, saveCreds } = await useRedisAuthState(this.phoneNumber, {
      clientName: this.clientName,
      webhookUrl: this.webhookUrl,
      webhookVerifyToken: this.webhookVerifyToken,
      includeMedia: this.includeMedia,
      syncFullHistory: this.syncFullHistory,
      groupsEnabled: this.groupsEnabled,
      autoPresenceSubscribe: this.autoPresenceSubscribe,
      apiKeyHash: this._apiKeyHash,
    });
    // Re-check after each await — discard() may have run while we were
    // loading auth state or fetching the version. Without this, the
    // discarded instance would still call makeWASocket() and race the
    // replacement on the same identity.
    if (this.isDiscarded) {
      return;
    }
    this.clearAuthState = state.keys.clear;

    const version = await fetchBaileysClientVersion().catch((error) => {
      logger.error(
        "[%s] [fetchBaileysVersion] Failed to fetch latest WhatsApp Web version, falling back to internal version. %s",
        this.phoneNumber,
        errorToString(error),
      );
      return undefined;
    });
    if (this.isDiscarded) {
      return;
    }

    // A discarded connection must never write Signal state again — its
    // identity may already be live on another instance (or on a local
    // replacement). This entry guard is a best-effort fast path; the
    // authoritative fence is the Redis-side write-if-owner script, which
    // rejects any write once the lease moves to a new owner. A write already
    // in flight when discard() lands can only commit while no successor holds
    // the lease, i.e. it is the closing socket's final state flush — exactly
    // what the next owner should resume from.
    const guardedKeys: AuthenticationState["keys"] = {
      ...state.keys,
      set: async (data) => {
        if (this.isDiscarded) {
          return;
        }
        await state.keys.set(data);
      },
    };

    const socketOptions: UserFacingSocketConfig = {
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(guardedKeys, logger),
      },
      markOnlineOnConnect: false,
      logger: baileysLogger,
      browser: Browsers.windows(this.clientName),
      syncFullHistory: this.syncFullHistory,
      shouldIgnoreJid,
      version,
    };

    try {
      this.socket = makeWASocket(socketOptions);
    } catch (error) {
      logger.error(
        "[%s] [BaileysConnection.connect] Failed to create socket: %s",
        this.phoneNumber,
        errorToString(error),
      );
      this.onConnectionClose?.();
      return;
    }

    this.addEventListeners({ saveCreds });
  }

  private addEventListeners({ saveCreds }: { saveCreds: () => Promise<void> }) {
    type EventHandlers = {
      [K in keyof BaileysEventMap]?: (
        data: BaileysEventMap[K],
      ) => Promise<void>;
    };

    const handledEvents: EventHandlers = {
      "creds.update": this.withErrorHandling("saveCreds", async () => {
        // See guardedKeys: a discarded socket must not persist creds.
        if (this.isDiscarded) {
          return;
        }
        await saveCreds();
      }),
      "connection.update": this.withErrorHandling(
        "handleConnectionUpdate",
        this.handleConnectionUpdate,
      ),
      "messages.upsert": this.withErrorHandling(
        "handleMessagesUpsert",
        this.handleMessagesUpsert,
      ),
      "messages.update": this.withErrorHandling(
        "handleMessagesUpdate",
        this.handleMessagesUpdate,
      ),
      "message-receipt.update": this.withErrorHandling(
        "handleMessageReceiptUpdate",
        this.handleMessageReceiptUpdate,
      ),
      // Antecedent signal to the 463 restriction: WhatsApp's new-chat message
      // cap. Handled (not left to the generic forwarder) so it is always
      // delivered, independent of BAILEYS_LISTEN_TO_EVENTS.
      "message-capping.update": this.withErrorHandling(
        "handleMessageCappingUpdate",
        this.handleMessageCappingUpdate,
      ),
      "messaging-history.set": this.withErrorHandling(
        "handleMessagingHistorySet",
        this.handleMessagingHistorySet,
      ),
      "groups.update": this.withErrorHandling(
        "handleGroupsUpdate",
        this.handleGroupsUpdate,
      ),
      "group-participants.update": this.withErrorHandling(
        "handleGroupParticipantsUpdate",
        this.handleGroupParticipantsUpdate,
      ),
      "presence.update": this.withErrorHandling(
        "handlePresenceUpdate",
        this.handlePresenceUpdate,
      ),
    };

    Object.entries(handledEvents).forEach(([event, handler]) => {
      this.socket?.ev.on(
        event as keyof BaileysEventMap,
        handler as (arg: unknown) => void,
      );
    });

    this.ALL_BAILEYS_SOCKET_EVENTS.forEach((event) => {
      if (event in handledEvents || !config.baileys.listenToEvents.has(event)) {
        return;
      }

      this.socket?.ev.on(event, (data) => this.sendToWebhook({ event, data }));
    });
  }

  private async close() {
    this.stopGroupActivityFlush();
    if (this.clearOnlinePresenceTimeout) {
      clearTimeout(this.clearOnlinePresenceTimeout);
      this.clearOnlinePresenceTimeout = null;
    }
    await this.clearAuthState?.();
    this.clearAuthState = null;
    this.socket = null;
    this.reconnectCount = 0;
    this.connectionReplacedTimestamps = [];
    this.onConnectionClose?.();
  }

  async logout() {
    // Mark as discarded up front so any close event the socket emits during
    // the logout flow (e.g. a connectionReplaced from another device while
    // we're awaiting the WhatsApp logout RPC) is treated as terminal by
    // handleConnectionUpdate and does not schedule a reconnect that would
    // resurrect the socket while logout is still in flight.
    this.isDiscarded = true;
    try {
      await this.safeSocket().logout();
    } catch (error) {
      logger.error(
        "[%s] [LOGOUT] error=%s",
        this.phoneNumber,
        errorToString(error),
      );
    }
    await this.close();
  }

  // Atomically disowns this connection so it cannot resurrect itself.
  // Used by the handler when a stale connection is being replaced (e.g.
  // recovery path from BaileysNotConnectedError, or a stuck reconnect
  // backoff). Does NOT clear the Redis auth state — the replacement will
  // reuse the same identity — and does NOT fire onConnectionClose — the
  // handler driving the discard already owns the replacement, and a late
  // callback would only race with it.
  discard() {
    if (this.isDiscarded) {
      return;
    }
    this.isDiscarded = true;
    this.onConnectionClose = null;
    this.stopGroupActivityFlush();
    if (this.clearOnlinePresenceTimeout) {
      clearTimeout(this.clearOnlinePresenceTimeout);
      this.clearOnlinePresenceTimeout = null;
    }
    try {
      // Drop listeners first so the synchronous `connection.update {close}`
      // that `end()` emits doesn't reach handleConnectionUpdate at all.
      // The flag guards a second line of defense, but unsubscribing keeps
      // the handler graph clean even if a stray event slips through.
      this.socket?.ev.removeAllListeners("connection.update");
      this.socket?.end(undefined);
    } catch (error) {
      logger.warn(
        "[%s] [discard] error while ending socket: %s",
        this.phoneNumber,
        errorToString(error),
      );
    }
    this.socket = null;
  }

  // Terminal teardown for a connection that gives up on itself (e.g. a
  // reconnect loop that never stabilizes). Unlike close(), preserves the
  // Redis auth state so the same identity can be resumed later — by a new
  // POST /connections or by another instance sharing this Redis. Unlike
  // discard(), fires onConnectionClose so the handler evicts this instance
  // from its registry.
  private abort() {
    const onConnectionClose = this.onConnectionClose;
    this.discard();
    onConnectionClose?.();
  }

  async sendMessage(
    jid: string,
    messageContent: AnyMessageContent,
    options?: { quoted?: WAMessage },
  ) {
    this.safeSocket();
    this.markTraffic();
    this.autoSubscribePresence(jid);

    let waveformProxy: Buffer | null = null;
    try {
      if ("audio" in messageContent && Buffer.isBuffer(messageContent.audio)) {
        const originalAudio = messageContent.audio;
        // NOTE: Due to limitations in internal Baileys logic used to generate waveform, we use a wav proxy.
        [messageContent.audio, waveformProxy] = await Promise.all([
          preprocessAudio(
            originalAudio,
            // NOTE: Use lower quality for ptt messages for more realistic quality.
            messageContent.ptt ? "ogg-low" : "mp3-high",
          ),
          messageContent.ptt ? preprocessAudio(originalAudio, "wav") : null,
        ]);
        messageContent.mimetype = messageContent.ptt
          ? "audio/ogg; codecs=opus"
          : "audio/mpeg";
      }
    } catch (error) {
      // NOTE: This usually means ffmpeg is not installed.
      logger.error(
        "[%s] [sendMessage] [ERROR] error=%s",
        this.phoneNumber,
        errorToString(error),
      );
    }

    return this.safeSocket().sendMessage(jid, messageContent, {
      waveformProxy,
      quoted: options?.quoted,
    });
  }

  sendPresenceUpdate(type: WAPresence, toJid?: string | undefined) {
    if (!this.safeSocket().authState.creds.me) {
      return;
    }

    if (toJid && ["composing", "recording", "paused"].includes(type)) {
      this.autoSubscribePresence(toJid);
    }

    return this.safeSocket()
      .sendPresenceUpdate(type, toJid)
      .then(() => {
        if (
          this.clearOnlinePresenceTimeout &&
          ["unavailable", "available"].includes(type)
        ) {
          clearTimeout(this.clearOnlinePresenceTimeout);
          this.clearOnlinePresenceTimeout = null;
        }
        if (type === "available") {
          this.clearOnlinePresenceTimeout = setTimeout(() => {
            this.clearOnlinePresenceTimeout = null;
            this.socket?.sendPresenceUpdate("unavailable", toJid);
          }, 60000);
        }
      });
  }

  async presenceSubscribe(jids: string[]) {
    this.safeSocket();
    await this.ensureAvailablePresence();
    const subscribed: string[] = [];

    for (const jid of jids) {
      try {
        const resolvedJid =
          (await this.resolveToPN(jid).catch(() => null)) ?? jid;
        await this.safeSocket().presenceSubscribe(resolvedJid);
        subscribed.push(jid);
      } catch (error) {
        logger.error(
          "[%s] [presenceSubscribe] Failed to subscribe to %s: %s",
          this.phoneNumber,
          jid,
          errorToString(error),
        );
      }
    }

    return { subscribed };
  }

  private autoSubscribePresence(jid: string) {
    if (!this.autoPresenceSubscribe) return;
    if (isJidGroup(jid)) return;

    this.resolveToPN(jid)
      .then((pnJid) => {
        const targetJid = pnJid ?? jid;
        return this.ensureAvailablePresence()
          .then(() => this.safeSocket().presenceSubscribe(targetJid))
          .then(() => {
            logger.debug(
              "[%s] [autoSubscribePresence] Subscribed to %s",
              this.phoneNumber,
              targetJid,
            );
          });
      })
      .catch((error) => {
        logger.error(
          "[%s] [autoSubscribePresence] Failed for %s: %s",
          this.phoneNumber,
          jid,
          errorToString(error),
        );
      });
  }

  private async resolveToPN(jid: string): Promise<string | null> {
    if (!jid.endsWith("@lid")) return jid;
    return this.safeSocket().signalRepository.lidMapping.getPNForLID(jid);
  }

  private async ensureAvailablePresence() {
    if (this.clearOnlinePresenceTimeout) return;
    await this.sendPresenceUpdate("available");
  }

  readMessages(keys: proto.IMessageKey[]) {
    return this.safeSocket().readMessages(keys);
  }

  chatModify(mod: ChatModification, jid: string) {
    return this.safeSocket().chatModify(mod, jid);
  }

  fetchMessageHistory(
    count: number,
    oldestMsgKey: proto.IMessageKey,
    oldestMsgTimestamp: number,
  ) {
    return this.safeSocket().fetchMessageHistory(
      count,
      oldestMsgKey,
      oldestMsgTimestamp,
    );
  }

  sendReceipts(keys: proto.IMessageKey[], type: MessageReceiptType) {
    return this.safeSocket().sendReceipts(keys, type);
  }

  deleteMessage(jid: string, key: MessageKeyWithId) {
    return this.safeSocket().sendMessage(jid, { delete: key });
  }

  editMessage(
    jid: string,
    key: proto.IMessageKey,
    messageContent: AnyMessageContent,
  ) {
    return this.safeSocket().sendMessage(jid, {
      ...messageContent,
      edit: key,
    } as AnyMessageContent);
  }

  async profilePictureUrl(jid: string, type?: "preview" | "image") {
    return this.safeSocket().profilePictureUrl(jid, type);
  }

  // Read-only restriction diagnostics. Both query WhatsApp directly via MEX
  // (GraphQL) queries — they do NOT send a message, so they are safe to call
  // on a 463-restricted account without worsening the reach-out time-lock.
  getReachoutTimelock() {
    return this.safeSocket().fetchAccountReachoutTimelock();
  }

  getNewChatMessageCap() {
    return this.safeSocket().fetchNewChatMessageCap();
  }

  async updateProfilePicture(jid: string, image: Buffer) {
    return this.safeSocket().updateProfilePicture(jid, image);
  }

  onWhatsApp(jids: string[]) {
    return this.safeSocket().onWhatsApp(...jids);
  }

  getBusinessProfile(jid: string) {
    return this.safeSocket().getBusinessProfile(jid);
  }

  groupMetadata(jid: string) {
    return this.safeSocket().groupMetadata(jid);
  }

  groupParticipants(
    jid: string,
    participants: string[],
    action: ParticipantAction,
  ) {
    return this.safeSocket().groupParticipantsUpdate(jid, participants, action);
  }

  groupUpdateSubject(jid: string, subject: string) {
    return this.safeSocket().groupUpdateSubject(jid, subject);
  }

  groupUpdateDescription(jid: string, description?: string) {
    return this.safeSocket().groupUpdateDescription(jid, description);
  }

  groupCreate(subject: string, participants: string[]) {
    return this.safeSocket().groupCreate(subject, participants);
  }

  groupLeave(jid: string) {
    return this.safeSocket().groupLeave(jid);
  }

  groupRequestParticipantsList(jid: string) {
    return this.safeSocket().groupRequestParticipantsList(jid);
  }

  groupRequestParticipantsUpdate(
    jid: string,
    participants: string[],
    action: "approve" | "reject",
  ) {
    return this.safeSocket().groupRequestParticipantsUpdate(
      jid,
      participants,
      action,
    );
  }

  groupInviteCode(jid: string) {
    return this.safeSocket().groupInviteCode(jid);
  }

  groupRevokeInvite(jid: string) {
    return this.safeSocket().groupRevokeInvite(jid);
  }

  groupAcceptInvite(code: string) {
    return this.safeSocket().groupAcceptInvite(code);
  }

  groupRevokeInviteV4(groupJid: string, invitedJid: string) {
    return this.safeSocket().groupRevokeInviteV4(groupJid, invitedJid);
  }

  groupAcceptInviteV4(
    key: string | WAMessageKey,
    inviteMessage: proto.Message.IGroupInviteMessage,
  ) {
    return this.safeSocket().groupAcceptInviteV4(key, inviteMessage);
  }

  groupGetInviteInfo(code: string) {
    return this.safeSocket().groupGetInviteInfo(code);
  }

  groupToggleEphemeral(jid: string, ephemeralExpiration: number) {
    return this.safeSocket().groupToggleEphemeral(jid, ephemeralExpiration);
  }

  groupSettingUpdate(
    jid: string,
    setting: "announcement" | "not_announcement" | "locked" | "unlocked",
  ) {
    return this.safeSocket().groupSettingUpdate(jid, setting);
  }

  groupMemberAddMode(jid: string, mode: "admin_add" | "all_member_add") {
    return this.safeSocket().groupMemberAddMode(jid, mode);
  }

  groupJoinApprovalMode(jid: string, mode: "on" | "off") {
    return this.safeSocket().groupJoinApprovalMode(jid, mode);
  }

  groupFetchAllParticipating() {
    return this.safeSocket().groupFetchAllParticipating();
  }

  private safeSocket() {
    if (!this.socket) {
      throw new BaileysNotConnectedError();
    }
    return this.socket;
  }

  private async handleConnectionUpdate(data: Partial<ConnectionState>) {
    // A discarded connection must be inert. `socket.end()` fires a final
    // connection.update before the listeners are torn down; without this
    // guard the handler would dispatch `reconnecting` webhooks and even
    // attempt a reconnect on a connection the handler already replaced.
    if (this.isDiscarded) {
      return;
    }

    const { connection, qr, lastDisconnect, isNewLogin, isOnline } = data;

    // WhatsApp's authoritative reach-out time-lock state (the restriction
    // behind error 463). It rides on connection.update — sometimes standalone
    // (no `connection` field), e.g. when emitted by fetchAccountReachoutTimelock
    // — and falls through to the sendToWebhook below. Destructured explicitly
    // and logged so it stays visible in production and a future refactor of
    // this handler cannot silently drop the pass-through.
    const { reachoutTimeLock } = data;
    if (reachoutTimeLock) {
      logger.info(
        "[%s] [handleConnectionUpdate] reachoutTimeLock update (isActive=%s, enforcementType=%s, ends=%s)",
        this.phoneNumber,
        String(reachoutTimeLock.isActive ?? false),
        reachoutTimeLock.enforcementType ?? "",
        reachoutTimeLock.timeEnforcementEnds?.toISOString?.() ?? "",
      );
    }

    // NOTE: Reconnection flow
    // - `isNewLogin`: sent after close on first connection (see `shouldReconnect` below). We send a `reconnecting` update to indicate qr code has been read.
    // - `connection === "connecting"` sent on:
    //   - Server boot, so check for `this.isReconnect`
    //   - Right after new login, specifically with `qr` code but no value present
    const isReconnecting =
      isNewLogin ||
      (connection === "connecting" &&
        (("qr" in data && !qr) || this.isReconnect));
    if (isReconnecting) {
      logger.debug(
        "[%s] [handleConnectionUpdate] Reconnecting (isNewLogin=%d, isReconnect=%d, connection=%s, qr=%s)",
        this.phoneNumber,
        Number(isNewLogin ?? false),
        Number(this.isReconnect),
        connection ?? "",
        qr ?? "",
      );
      this.isReconnect = false;
      this.handleReconnecting();
      return;
    }

    if (connection === "close") {
      // TODO: Drop @hapi/boom dependency.
      const error = lastDisconnect?.error as Boom;
      const statusCode = error?.output?.statusCode;
      const message = error?.output?.payload?.message || error.message;
      const shouldReconnect =
        statusCode !== DisconnectReason.loggedOut &&
        message !== "QR refs attempts ended";

      if (shouldReconnect) {
        // Imported session with a wrong Noise candidate: the handshake fails
        // and the socket closes before ever opening. Advance to the next
        // candidate (re-seeding creds) and reconnect, until one works or the
        // list is exhausted. A no-op for any connection with no candidates
        // seeded (i.e. everything but a just-imported session).
        //
        // Guarded: advanceImportCandidate hits Redis on every reconnect (not
        // just imports). If that call throws (transient Redis failure) the
        // rejection would propagate out of the withErrorHandling wrapper and
        // skip the normal reconnect below, stranding the connection. Swallow
        // it and fall through to the standard reconnect path instead.
        //
        // A connectionReplaced kick is NOT a wrong-Noise-candidate signal: it
        // means another instance may legitimately own this identity. Exclude it
        // so it falls through to the shouldYieldToLeaseOwner fence below instead
        // of consuming candidates and fighting the owner until the list runs out.
        let advancedCandidate = false;
        if (
          !this.hasOpened &&
          statusCode !== DisconnectReason.connectionReplaced
        ) {
          try {
            advancedCandidate = await advanceImportCandidate(this.phoneNumber);
          } catch (candidateError) {
            logger.warn(
              "[%s] [handleConnectionUpdate] advanceImportCandidate failed; falling back to normal reconnect (error=%s)",
              this.phoneNumber,
              errorToString(candidateError),
            );
          }
        }
        if (advancedCandidate) {
          logger.info(
            "[%s] [handleConnectionUpdate] imported session closed before open; trying next Noise candidate",
            this.phoneNumber,
          );
          // Cycling Noise candidates is a bounded iteration (advanceImportCandidate
          // returns false once the list is exhausted), not a reconnect loop, so it
          // must not count against the reconnect-loop guard. Without this reset a
          // list longer than the guard threshold (10) aborts before reaching a
          // candidate past that index, and only a coordinator re-claim can resume it.
          this.reconnectCount = 0;
          await this.handleReconnecting();
          this.socket = null;
          this.connect();
          return;
        }
        // Distributed fence: a conflict/replaced kick may mean another
        // instance legitimately took this identity over (its lease says so).
        // Yield instead of stealing the connection back — the in-memory
        // backoff below only throttles that fight, it doesn't end it.
        if (
          statusCode === DisconnectReason.connectionReplaced &&
          (await this.shouldYieldToLeaseOwner())
        ) {
          this.abort();
          return;
        }
        logger.debug(
          "[%s] [handleConnectionUpdate] Reconnecting (lastDisconnect=%o)",
          this.phoneNumber,
          lastDisconnect ?? {},
        );
        await this.handleReconnecting();
        // NOTE: We don't call `this.close()` here because we want to keep the auth state.
        this.socket = null;

        if (statusCode === DisconnectReason.connectionReplaced) {
          const recentCount = this.trackConnectionReplaced();
          if (recentCount >= CONNECTION_REPLACED_LOOP_THRESHOLD) {
            logger.warn(
              "[%s] [handleConnectionUpdate] connectionReplaced loop detected (%d events in %dms window), backing off %dms before reconnect",
              this.phoneNumber,
              recentCount,
              CONNECTION_REPLACED_LOOP_WINDOW_MS,
              CONNECTION_REPLACED_BACKOFF_MS,
            );
            await asyncSleep(CONNECTION_REPLACED_BACKOFF_MS);
          }
        }

        this.connect();
        return;
      }
      await this.close();
    }

    if (connection === "open" && this.socket?.user?.id) {
      const phoneNumberFromId = `+${this.socket.user.id.split("@")[0].split(":")[0]}`;
      if (
        normalizeBrazilPhoneNumber(phoneNumberFromId) !==
        normalizeBrazilPhoneNumber(this.phoneNumber)
      ) {
        this.handleWrongPhoneNumber();
        return;
      }
    }

    if (qr) {
      Object.assign(data, {
        connection: "connecting",
        qrDataUrl: await toDataURL(qr),
      });
    }

    if (isOnline) {
      Object.assign(data, { connection: "open" });
    }

    if (data.connection === "open") {
      this.reconnectCount = 0;
      const isFirstOpen = !this.hasOpened;
      this.hasOpened = true;
      if (isFirstOpen) {
        // First healthy open — stop cycling Noise candidates on future
        // reconnects. Gated to the first open so later reconnects don't repeat
        // the fenced Redis write; a stale cursor is already harmless once
        // hasOpened is true. Not awaited (the open path must not block on it),
        // but the rejection is handled so a Redis failure surfaces in logs
        // instead of an unhandled rejection.
        clearImportCandidates(this.phoneNumber).catch((clearError) => {
          logger.warn(
            "[%s] [handleConnectionUpdate] clearImportCandidates failed; stale import cursor may remain (error=%s)",
            this.phoneNumber,
            errorToString(clearError),
          );
        });
      }
      this.startGroupActivityFlush();
    }

    this.sendToWebhook({
      event: "connection.update",
      data,
    });
  }

  private async handleMessagesUpsert(data: BaileysEventMap["messages.upsert"]) {
    this.markTraffic();
    if (data.type === "notify") {
      for (const msg of data.messages) {
        const remoteJid = msg.key?.remoteJid;
        if (remoteJid) {
          this.autoSubscribePresence(remoteJid);
        }
      }
    }

    let messagesData = data;

    if (!this.groupsEnabled) {
      const individualMessages: typeof data.messages = [];

      for (const msg of data.messages) {
        const remoteJid = msg.key?.remoteJid;
        if (remoteJid && isJidGroup(remoteJid)) {
          const existing = this.groupActivityMap.get(remoteJid);
          this.groupActivityMap.set(remoteJid, {
            unreadCount: (existing?.unreadCount ?? 0) + 1,
            lastMessageAt: Date.now(),
          });
        } else {
          individualMessages.push(msg);
        }
      }

      if (individualMessages.length === 0) {
        return;
      }

      messagesData = { ...data, messages: individualMessages };
    }

    const payload: BaileysConnectionWebhookPayload = {
      event: "messages.upsert",
      data: messagesData,
    };

    const media = await downloadMediaFromMessages(messagesData.messages, {
      includeMedia: this.includeMedia,
    });
    if (media) {
      payload.extra = { media };
    }

    this.sendToWebhook(payload);
  }

  private handleMessagesUpdate(data: BaileysEventMap["messages.update"]) {
    // Edits, deletions and reactions are conversation activity too — a
    // connection seeing them must not look idle to the rebalancer.
    this.markTraffic();

    // A 463 ("account restricted") surfaces here as a status=ERROR update. The
    // Baileys 463 handler does not emit the reach-out time-lock state on its
    // own, so we actively query it: the resulting connection.update carries
    // reachoutTimeLock to the webhook, giving the consumer a structured,
    // authoritative signal instead of just a failed message.
    if (this.hasAccountRestrictionError(data)) {
      this.fetchReachoutTimelockOn463();
    }

    this.sendToWebhook(
      {
        event: "messages.update",
        data,
      },
      {
        awaitResponse: true,
      },
    );
  }

  private hasAccountRestrictionError(
    data: BaileysEventMap["messages.update"],
  ): boolean {
    return data.some(
      ({ update }) =>
        update?.status === WAMessageStatus.ERROR &&
        Array.isArray(update.messageStubParameters) &&
        update.messageStubParameters.includes(MESSAGE_ACCOUNT_RESTRICTION_CODE),
    );
  }

  // Fire-and-forget, debounced. fetchAccountReachoutTimelock emits a
  // connection.update { reachoutTimeLock } which handleConnectionUpdate
  // forwards to the webhook. Safe on a restricted account (read-only MEX
  // query, sends no message).
  private fetchReachoutTimelockOn463() {
    if (this.reachoutTimelockFetchInFlight) {
      return;
    }
    const now = Date.now();
    if (
      now - this.lastReachoutTimelockFetchAt <
      REACHOUT_TIMELOCK_REFETCH_WINDOW_MS
    ) {
      return;
    }
    this.reachoutTimelockFetchInFlight = true;
    this.lastReachoutTimelockFetchAt = now;
    void (async () => {
      try {
        await this.getReachoutTimelock();
      } catch (error) {
        logger.warn(
          "[%s] [fetchReachoutTimelockOn463] failed to fetch reachout timelock: %s",
          this.phoneNumber,
          errorToString(error),
        );
      } finally {
        this.reachoutTimelockFetchInFlight = false;
      }
    })();
  }

  private handleMessageCappingUpdate(
    data: BaileysEventMap["message-capping.update"],
  ) {
    this.sendToWebhook({
      event: "message-capping.update",
      data,
    });
  }

  private handleMessageReceiptUpdate(
    data: BaileysEventMap["message-receipt.update"],
  ) {
    this.markTraffic();
    this.sendToWebhook({
      event: "message-receipt.update",
      data,
    });
  }

  private handleMessagingHistorySet(
    data: BaileysEventMap["messaging-history.set"],
  ) {
    if (!this.syncFullHistory) {
      return;
    }

    // NOTE: messaging-history.set event has a payload size is typically extensive so it does not include base64 media content, regardless of the `includeMedia` option.
    // FIXME: Downloads are failing heavily right now. Under investigation.
    // await downloadMediaFromMessages(data.messages);

    this.sendToWebhook({ event: "messaging-history.set", data });
  }

  private handleGroupsUpdate(data: BaileysEventMap["groups.update"]) {
    this.sendToWebhook({
      event: "groups.update",
      data,
    });
  }

  private handleGroupParticipantsUpdate(
    data: BaileysEventMap["group-participants.update"],
  ) {
    this.sendToWebhook({
      event: "group-participants.update",
      data,
    });
  }

  private async handlePresenceUpdate(data: BaileysEventMap["presence.update"]) {
    const enrichedData = { ...data } as BaileysEventMap["presence.update"] & {
      jidAlt?: string;
    };

    if (data.id.endsWith("@lid")) {
      try {
        const pn =
          await this.safeSocket().signalRepository.lidMapping.getPNForLID(
            data.id,
          );
        if (pn) {
          enrichedData.jidAlt = pn;
        }
      } catch (error) {
        logger.error(
          "[%s] [handlePresenceUpdate] Failed to resolve LID %s: %s",
          this.phoneNumber,
          data.id,
          errorToString(error),
        );
      }
    }

    this.sendToWebhook({
      event: "presence.update",
      data: enrichedData,
    });
  }

  private handleWrongPhoneNumber() {
    this.sendToWebhook({
      event: "connection.update",
      data: { error: "wrong_phone_number" },
    });
    this.socket?.ev.removeAllListeners("connection.update");
    // Route teardown through the handler so the logout participates in
    // inFlightOps (serializes with any concurrent connect/logout/discard for
    // this number). Falls back to a direct logout when no handler wired a
    // callback (e.g. a standalone BaileysConnection). See issue #313.
    if (this.requestLogout) {
      this.requestLogout();
    } else {
      this.logout();
    }
  }

  private async handleReconnecting() {
    this.reconnectCount += 1;
    if (this.reconnectCount > 10) {
      logger.warn(
        "[%s] [handleReconnecting] Reconnect count exceeded 10, aborting reconnection (auth state preserved)",
        this.phoneNumber,
      );
      this.sendToWebhook({
        event: "connection.update",
        data: { error: "reconnect_loop_detected" },
      });
      this.abort();
      return;
    }
    this.sendToWebhook({
      event: "connection.update",
      data: { connection: "reconnecting" as WAConnectionState },
    });
  }

  // True only when the lease verifiably belongs to another instance. On any
  // doubt (no lease system state, Redis unreachable) we keep the
  // single-instance behavior — reconnect with backoff — because wrongly
  // yielding here silently kills a healthy connection.
  private async shouldYieldToLeaseOwner(): Promise<boolean> {
    try {
      const lease = await getLease(this.phoneNumber);
      if (lease && lease.owner !== instanceId) {
        logger.info(
          "[%s] [shouldYieldToLeaseOwner] lease is owned by %s (epoch %d), yielding",
          this.phoneNumber,
          lease.owner,
          lease.epoch,
        );
        return true;
      }
      return false;
    } catch (error) {
      logger.warn(
        "[%s] [shouldYieldToLeaseOwner] could not verify lease, keeping reconnect behavior: %s",
        this.phoneNumber,
        errorToString(error),
      );
      return false;
    }
  }

  private trackConnectionReplaced(): number {
    const now = Date.now();
    this.connectionReplacedTimestamps =
      this.connectionReplacedTimestamps.filter(
        (ts) => now - ts <= CONNECTION_REPLACED_LOOP_WINDOW_MS,
      );
    this.connectionReplacedTimestamps.push(now);
    return this.connectionReplacedTimestamps.length;
  }

  private startGroupActivityFlush() {
    this.stopGroupActivityFlush();
    if (this.groupsEnabled) {
      return;
    }
    this.groupActivityInterval = setInterval(() => {
      this.flushGroupActivity();
    }, 30_000);
  }

  private flushGroupActivity() {
    if (this.groupActivityMap.size === 0) {
      return;
    }

    const activities: Array<{
      jid: string;
      unreadCount: number;
      lastMessageAt: number;
    }> = [];

    for (const [jid, activity] of this.groupActivityMap) {
      activities.push({ jid, ...activity });
    }
    this.groupActivityMap.clear();

    this.sendToWebhook({
      event: "groups.activity" as keyof BaileysEventMap,
      data: activities,
    });
  }

  private stopGroupActivityFlush() {
    if (this.groupActivityInterval) {
      clearInterval(this.groupActivityInterval);
      this.groupActivityInterval = null;
    }
    this.flushGroupActivity();
  }

  // Counts deliveries (including their retry windows) still running in this
  // process's memory. Graceful shutdown waits on this before exiting so a
  // handoff doesn't drop events that WhatsApp already considers delivered.
  private async sendToWebhook(
    payload: BaileysConnectionWebhookPayload,
    options?: {
      awaitResponse?: boolean;
    },
  ) {
    // connection.update events carry the lease epoch so the client can
    // discard late events from a previous owner (last-writer-wins on the
    // chatwoot side would otherwise let a stale "reconnecting" overwrite the
    // new owner's "open").
    let enriched = payload;
    if (payload.event === "connection.update" && this.leaseEpoch !== null) {
      enriched = {
        ...payload,
        data: {
          ...(payload.data as BaileysEventMap["connection.update"]),
          epoch: this.leaseEpoch,
        },
      };
    }
    this._inFlightWebhooks += 1;
    try {
      return await this.deliverToWebhook(enriched, options);
    } finally {
      this._inFlightWebhooks -= 1;
    }
  }

  private async deliverToWebhook(
    payload: BaileysConnectionWebhookPayload,
    options?: {
      awaitResponse?: boolean;
    },
  ) {
    let sanitizedPayload: Record<string, unknown> | null = null;
    if (logger.isLevelEnabled("debug")) {
      sanitizedPayload = deepSanitizeObject(
        { ...payload },
        {
          omitKeys: [...this.LOGGER_OMIT_KEYS],
        },
      );
      logger.debug(
        "[%s] [sendToWebhook] (options: %o) payload=%o",
        this.phoneNumber,
        options || {},
        sanitizedPayload,
      );
    }

    // Snapshot webhook destination to prevent updateOptions() from changing
    // the target mid-retry.
    const webhookUrl = this.webhookUrl;

    const serializedBody = JSON.stringify({
      ...payload,
      webhookVerifyToken: this.webhookVerifyToken,
      awaitResponse: options?.awaitResponse,
    });

    const { maxRetries, retryInterval, backoffFactor } =
      config.webhook.retryPolicy;
    let attempt = 0;
    let delay = retryInterval;

    while (attempt <= maxRetries) {
      const { response, error } = await this.sendPayloadToWebhook(
        webhookUrl,
        serializedBody,
      );
      if (response) {
        if (response.ok) {
          if (logger.isLevelEnabled("debug")) {
            logger.debug(
              "[%s] [sendToWebhook] [SUCCESS] event=%s status=%d",
              this.phoneNumber,
              payload.event,
              response.status,
            );
          }
          return response;
        }
        logger.error(
          "[%s] [sendToWebhook] [ERROR] webhookUrl=%s payload=%o response=%o",
          this.phoneNumber,
          webhookUrl,
          sanitizedPayload ?? payload.event,
          { status: response.status, statusText: response.statusText },
        );
      }

      if (error) {
        logger.error(
          "[%s] [sendToWebhook] [ERROR] webhookUrl=%s payload=%o error=%s",
          this.phoneNumber,
          webhookUrl,
          sanitizedPayload ?? payload.event,
          errorToString(error),
        );
      }

      attempt++;
      if (attempt <= maxRetries) {
        logger.info(
          "[%s] [sendToWebhook] [RETRYING] payload=%o attempt=%d/%d delay=%dms",
          this.phoneNumber,
          sanitizedPayload ?? payload.event,
          attempt,
          maxRetries,
          delay,
        );
        const jitter = Math.floor(Math.random() * 1000);
        await asyncSleep(delay + jitter);
        delay *= backoffFactor;
      }
    }

    logger.error(
      "[%s] [sendToWebhook] [FAILED] webhookUrl=%s payload=%o",
      this.phoneNumber,
      webhookUrl,
      sanitizedPayload ?? payload.event,
    );
  }

  private async sendPayloadToWebhook(
    webhookUrl: string,
    serializedBody: string,
  ): Promise<{ response?: Response; error?: Error }> {
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: serializedBody,
      });
      return { response };
    } catch (error) {
      return { error: error as Error };
    }
  }
}
