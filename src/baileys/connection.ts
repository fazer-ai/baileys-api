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
import { isTxMutexTimeout } from "@/baileys/helpers/isTxMutexTimeout";
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
import {
  clearQuarantine,
  type QuarantineState,
  recordStrike,
} from "@/cluster/quarantineStore";
import {
  canRestart as canRestartAfterStall,
  nextRestartAllowedAt,
  recordRestart as recordStallRestart,
} from "@/cluster/sendStallStore";
import config from "@/config";
import { asyncSleep } from "@/helpers/asyncSleep";
import { errorToString } from "@/helpers/errorToString";
import { OperationTimeoutError, withTimeout } from "@/helpers/withTimeout";
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

// Send-stall watchdog. Six keystore operations serialize on a mutex keyed by
// our own JID, so once one of them wedges, EVERY send on this connection times
// out while receiving and health checks stay perfect -- the connection goes
// mute without a single error, for minutes or for hours.
//
// Consecutive timeouts, not a sliding window: the failure is total, so one
// success proves the mutex is free and a consecutive counter is the exact shape
// of the signal. The minimum streak duration exists because three concurrent
// sends started together all expire at sendTimeoutMs, which would otherwise let
// one 45s hiccup with three sends in flight recreate a healthy socket.
const SEND_STALL_THRESHOLD = 3;
const SEND_STALL_MIN_DURATION_MS = 90_000;
// Spreads restarts across a fleet-wide event: with several inboxes stalled at
// once, they recover over minutes instead of reconnecting simultaneously
// against the same IP.
const SEND_STALL_RESTART_COOLDOWN_MS = 30_000;
// How many recently submitted WhatsApp ids to remember for ack matching. An ack
// follows its send within seconds, so this is generous; the cap is what keeps a
// long-lived busy connection from growing the set without bound.
const SUBMITTED_ID_HISTORY = 500;

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

// Raised instead of attempting a send the connection is known to be unable to
// complete. Queueing another operation behind a wedged mutex only grows the
// burst that fires if the mutex ever releases while the socket is still open —
// a burst of duplicate messages to real customers, hours late.
export class BaileysSendStalledError extends Error {
  constructor() {
    super("Connection is not accepting sends");
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
  private requestRestart: ((reason: string) => void) | null;
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
  // The socket's actual state, as WhatsApp last reported it. Registration in the
  // handler is NOT connectivity: a connection is registered before it ever opens
  // (QR pairing) and stays registered while its socket is closed and backing off,
  // which is exactly when a health check must not claim it is connected.
  private connectionState: WAConnectionState = "connecting";
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
  // Identifies the socket the watchdog state below belongs to. Incremented once
  // per makeWASocket, which is the ONLY event that gives a fresh keystore and a
  // fresh mutex map — the two things the watchdog actually reasons about. It
  // exists because neither side of that state can be trusted without it: an
  // `isOnline` presence echo arrives as `connection: "open"` on the SAME wedged
  // socket, and a timeout from a socket that has since been replaced settles
  // long after its deadlines stopped mattering. Every read and write of the
  // fields below is stamped with the generation it describes.
  private socketGeneration = 0;
  // Send-stall watchdog state. Deliberately in memory and never in Redis: a
  // restart gives a new socket, hence a new keystore and a new mutex map, so
  // the count must die with the socket. Persisted state would survive the
  // restart and drive a restart loop.
  private _consecutiveSendTimeouts = 0;
  private sendStallStreakStartedAt: number | null = null;
  private restartRequested = false;
  // When this episode may be reported again. 0 means now; Infinity means never
  // again on this socket. A finite timestamp is the middle case that matters:
  // the report was DEFERRED, and the deferral has an expiry the connection
  // already advertised to the client as `until`. Without it the breaker-open
  // path would emit a webhook for every rejected send, since the breaker keeps
  // rejecting for as long as the socket lives.
  private sendStallSilentUntil = 0;
  // Wall-clock (not performance.now()) so it can be reported as an age to
  // clients and driven by setSystemTime in tests, matching
  // trackConnectionReplaced.
  private _lastSendCompletedAt: number | null = null;
  private _lastOutgoingAckAt: number | null = null;
  // WhatsApp ids this socket actually submitted, so an ack can be told apart from
  // the same account's traffic on another device. Insertion-ordered and capped:
  // an ack that matters arrives seconds after its send, so the oldest entries are
  // dead weight, and an unbounded set on a busy connection is a leak.
  private submittedMessageIds = new Set<string>();

  constructor(phoneNumber: string, options: BaileysConnectionOptions) {
    this.phoneNumber = phoneNumber;
    this.clientName = options.clientName || "Chrome";
    this.webhookUrl = options.webhookUrl;
    this.webhookVerifyToken = options.webhookVerifyToken;
    this.onConnectionClose = options.onConnectionClose || null;
    this.requestLogout = options.requestLogout ?? null;
    this.requestRestart = options.requestRestart ?? null;
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

  private trackSubmittedId(messageId: string) {
    if (this.submittedMessageIds.size >= SUBMITTED_ID_HISTORY) {
      const oldest = this.submittedMessageIds.values().next().value;
      if (oldest !== undefined) {
        this.submittedMessageIds.delete(oldest);
      }
    }
    this.submittedMessageIds.add(messageId);
  }

  // The connection's CURRENT options, which are not the ones it was built with:
  // a later POST /connections reuses a live connection and mutates these in
  // place via updateOptions. Anything that rebuilds the socket has to read them
  // from here, because the options captured when it was spawned may since have
  // been superseded — and persistMetadata would write the stale copy back to
  // Redis, silently reverting a webhook reconfiguration.
  get currentOptions(): BaileysConnectionOptions {
    return {
      clientName: this.clientName,
      webhookUrl: this.webhookUrl,
      webhookVerifyToken: this.webhookVerifyToken,
      includeMedia: this.includeMedia,
      syncFullHistory: this.syncFullHistory,
      groupsEnabled: this.groupsEnabled,
      autoPresenceSubscribe: this.autoPresenceSubscribe,
      ...(this._apiKeyHash !== null && { apiKeyHash: this._apiKeyHash }),
      leaseEpoch: this.leaseEpoch,
    };
  }

  get lastSendCompletedAt(): number | null {
    return this._lastSendCompletedAt;
  }

  get lastOutgoingAckAt(): number | null {
    return this._lastOutgoingAckAt;
  }

  get consecutiveSendTimeouts(): number {
    return this._consecutiveSendTimeouts;
  }

  get isOpen(): boolean {
    return this.connectionState === "open" && this.socket !== null;
  }

  // "unknown" is a first-class answer, not a fallback: a connection nobody
  // writes to can be wedged for hours and still look perfect, and reporting it
  // as healthy is worse than admitting we have not observed a send.
  get sendState(): "unknown" | "ok" | "degraded" | "stalled" {
    if (this._consecutiveSendTimeouts >= SEND_STALL_THRESHOLD) {
      return "stalled";
    }
    if (this._consecutiveSendTimeouts > 0) {
      return "degraded";
    }
    if (
      this._lastSendCompletedAt === null &&
      this._lastOutgoingAckAt === null
    ) {
      return "unknown";
    }
    return "ok";
  }

  // Reported by the patched addTransactionCapability. Logged here rather than
  // inside the patch because the logger the lib holds is baileysLogger, whose
  // level is BAILEYS_LOG_LEVEL (often `error` in production) — a warn from
  // inside the patch would be invisible exactly where it matters.
  private handleTxEvent(event: {
    phase: "acquired" | "released" | "stalled" | "timeout";
    key: string;
    waitedMs: number;
    heldMs?: number;
    originStack?: string;
    stillLocked?: boolean;
  }) {
    if (event.phase === "acquired" || event.phase === "released") {
      return;
    }
    logger.warn(
      "[%s] [keystoreTx] %s key=%s waitedMs=%d heldMs=%s stillLocked=%s stack=%s",
      this.phoneNumber,
      event.phase,
      event.key,
      event.waitedMs,
      event.heldMs ?? "-",
      event.stillLocked ?? "-",
      event.originStack ?? "-",
    );
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
      // Deadline for the lib's own HTTP downloads. Read by the patched
      // getHttpStream; without it an app-state blob download can park forever
      // inside the keystore transaction and mute this connection's sends.
      options: { timeoutMs: config.baileys.httpTimeoutMs },
      // NOTE: The config merge in the lib is shallow, so supplying
      // transactionOpts replaces the whole default object — maxCommitRetries
      // and delayBetweenTriesMs must be restated at their upstream defaults.
      transactionOpts: {
        maxCommitRetries: 10,
        delayBetweenTriesMs: 3000,
        acquireTimeoutMs: config.baileys.txAcquireTimeoutMs,
        holdWarnMs: config.baileys.txHoldWarnMs,
        onTransactionEvent: (event) => this.handleTxEvent(event),
      },
    };

    try {
      this.socket = makeWASocket(socketOptions);
      // The new socket carries a new keystore and a new mutex map. Bumping here
      // (and only here) is what makes every stamped watchdog reading below
      // mean "observed on the socket that is live right now".
      this.socketGeneration += 1;
      // The id history belongs to the socket that submitted them. A delayed
      // receipt for a message the PREVIOUS socket sent would otherwise stamp
      // lastOutgoingAckAt now, presenting end-to-end evidence about a
      // replacement that may itself be wedged and has sent nothing.
      this.submittedMessageIds.clear();
      // And the evidence itself, for the same reason and with more force: any
      // non-null value makes sendState read `ok`, so a replacement that has
      // never sent anything would inherit the previous socket's health report
      // and hold it indefinitely. `unknown` is the true answer for a socket
      // nobody has written through yet.
      this._lastSendCompletedAt = null;
      this._lastOutgoingAckAt = null;
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
    options?: { quoted?: WAMessage; messageId?: string },
  ) {
    this.safeSocket();
    // Before the audio work below, not only inside relayWithTimeout. An open breaker
    // means this request is already decided, and preprocessAudio runs up to two ffmpeg
    // jobs for a PTT: a caller retrying into a stalled connection would burn that CPU
    // on every attempt to be told 503 at the end. "Fails immediately" has to mean
    // immediately.
    this.assertCanSend();
    this.markTraffic();
    this.autoSubscribePresence(jid);
    if (options?.messageId) {
      this.trackSubmittedId(options.messageId);
    }

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

    // NOTE: `messageId` overrides the id Baileys would generate for the WhatsApp
    // message key. The caller reserves it before the send so it can match the
    // `messages.upsert` echo of its own message even when this response never
    // reaches it (and so a resend of the same message reuses the same id).
    // Spread it only when set: Baileys spreads our options over its own
    // `messageId: generateMessageIDV2(user)` default, so an explicit
    // `undefined` would downgrade that default to the user-less fallback.
    const sent = await this.relayWithTimeout("sendMessage", () =>
      this.safeSocket().sendMessage(jid, messageContent, {
        waveformProxy,
        quoted: options?.quoted,
        ...(options?.messageId ? { messageId: options.messageId } : {}),
      }),
    );
    // Also on the way out, for the sends that let Baileys generate the id: without
    // a reservation this response is the first time we learn it, and an ack for it
    // still lands afterwards.
    if (sent?.key?.id) {
      this.trackSubmittedId(sent.key.id);
    }
    return sent;
  }

  // Throws when the breaker is open, and re-evaluates the episode on the way out.
  // The re-evaluation belongs here, not only where a fresh timeout lands: once the
  // breaker is open no send reaches the socket, so no further timeout is ever
  // recorded. Three sends started together all expire at sendTimeoutMs with a streak
  // near zero, which latches the breaker below the minimum duration — without this
  // the watchdog would stay disarmed for the life of the socket, answering 503 with
  // no webhook and no restart.
  private assertCanSend() {
    if (this._consecutiveSendTimeouts < SEND_STALL_THRESHOLD) {
      return;
    }
    this.maybeReportSendStall();
    throw new BaileysSendStalledError();
  }

  // Bounds every path that goes through the socket's sendMessage, which is what
  // takes the keystore transaction keyed by our own JID. `withTimeout` cannot
  // cancel the underlying operation — it stays parked in that mutex — so a
  // timeout means "outcome unknown", and the circuit breaker below is what
  // keeps the parked queue from growing with every caller retry.
  private async relayWithTimeout<T>(
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    this.assertCanSend();
    // Captured BEFORE the send starts, and carried into every callback below.
    // A reconnect mid-send replaces the socket while these deadlines keep
    // running against a keystore that no longer exists: unstamped, three of
    // them expiring after the swap would open the breaker on a healthy
    // replacement that had not refused a single send.
    const generation = this.socketGeneration;
    try {
      const result = await withTimeout(
        operation,
        config.baileys.sendTimeoutMs,
        fn,
        (error) => this.recordLateSettle(operation, generation, error),
      );
      this.recordSendSuccess(generation);
      return result;
    } catch (error) {
      if (error instanceof OperationTimeoutError) {
        this.recordSendTimeout(operation, generation);
      }
      throw error;
    }
  }

  // True while the argument still describes the live socket. A settlement from
  // an earlier generation is not wrong, it is about a keystore that has since
  // been thrown away, and the watchdog's whole subject is the current one.
  private isCurrentGeneration(generation: number): boolean {
    return generation === this.socketGeneration;
  }

  // Clears the breaker without asserting anything about a send having landed.
  // Split out because a late REJECTION proves the operation left the mutex
  // queue (which is what the breaker counts) but proves nothing about delivery,
  // so it must not touch the health timestamps.
  private clearSendStallState() {
    this._consecutiveSendTimeouts = 0;
    this.sendStallStreakStartedAt = null;
    this.sendStallSilentUntil = 0;
    // Also the restart request: a send going through proves the socket works, so a
    // pending restart is moot. Leaving it set would latch the same way the breaker
    // used to — if the restart never lands (the handler logs and gives up on a
    // failed connect), this connection could never report a stall again.
    this.restartRequested = false;
  }

  private recordSendSuccess(generation: number) {
    if (!this.isCurrentGeneration(generation)) {
      return;
    }
    this.clearSendStallState();
    this._lastSendCompletedAt = Date.now();
  }

  // A send we already gave up on finally settled. This is the ONLY signal that
  // can close the breaker without a new socket: once it is open no send reaches
  // the socket, so the ordinary success path can never run again. It is also
  // what keeps a slow-but-healthy connection out of a permanent 503 — media
  // generation and upload happen inside socket.sendMessage BEFORE the keystore
  // mutex, so three slow uploads can open the breaker with the mutex perfectly
  // free, and this is what closes it when they land.
  //
  // `error` present means the abandoned operation rejected. That still empties
  // the mutex queue, so it still closes the breaker — with one exception, and
  // it is the exception that matters: a rejection that IS the transaction-mutex
  // timeout reports a wedged mutex, not a freed one. Closing the breaker on it
  // would send the next batch straight back into the queue we are trying to
  // keep bounded.
  private recordLateSettle(
    operation: string,
    generation: number,
    error?: unknown,
  ) {
    if (this.isDiscarded || !this.isCurrentGeneration(generation)) {
      return;
    }
    if (error !== undefined && isTxMutexTimeout(error)) {
      logger.warn(
        "[%s] [sendStall] late tx-mutex timeout operation=%s afterTimeouts=%d (breaker stays open)",
        this.phoneNumber,
        operation,
        this._consecutiveSendTimeouts,
      );
      return;
    }
    logger.warn(
      "[%s] [sendStall] late %s operation=%s afterTimeouts=%d",
      this.phoneNumber,
      error === undefined ? "completion" : "failure",
      operation,
      this._consecutiveSendTimeouts,
    );
    if (error === undefined) {
      this.recordSendSuccess(generation);
      return;
    }
    // ONE slot, not the whole streak. A rejection proves this operation left the
    // queue; it does not prove the mutex is free, because media generation and
    // upload run BEFORE the transaction is taken — a failing upload can depart
    // while other sends are still queued behind a wedged mutex. Clearing
    // everything here would readmit a full batch into that queue and give up the
    // bound the breaker exists to hold. A late SUCCESS is different, and that is
    // why it clears: it proves the transaction was both acquired and released.
    this._consecutiveSendTimeouts = Math.max(
      0,
      this._consecutiveSendTimeouts - 1,
    );
    if (this._consecutiveSendTimeouts === 0) {
      this.clearSendStallState();
    }
  }

  private recordSendTimeout(operation: string, generation: number) {
    if (!this.isCurrentGeneration(generation)) {
      logger.warn(
        "[%s] [sendStall] ignoring timeout from a replaced socket operation=%s generation=%d current=%d",
        this.phoneNumber,
        operation,
        generation,
        this.socketGeneration,
      );
      return;
    }
    this._consecutiveSendTimeouts += 1;
    this.sendStallStreakStartedAt ??= Date.now();
    const streakMs = Date.now() - this.sendStallStreakStartedAt;

    logger.warn(
      "[%s] [sendStall] timeout operation=%s consecutive=%d streakMs=%d",
      this.phoneNumber,
      operation,
      this._consecutiveSendTimeouts,
      streakMs,
    );

    this.maybeReportSendStall();
  }

  // The trigger, shared by the timeout path and the breaker-open path. A stall
  // needs the streak to be both deep enough (consecutive timeouts) and long
  // enough: concurrent sends all expire at the same instant, so depth alone
  // would let one 45s hiccup recreate a perfectly healthy socket.
  private maybeReportSendStall() {
    if (
      Date.now() < this.sendStallSilentUntil ||
      this.sendStallStreakStartedAt === null
    ) {
      return;
    }
    if (this._consecutiveSendTimeouts < SEND_STALL_THRESHOLD) {
      return;
    }
    if (
      Date.now() - this.sendStallStreakStartedAt <
      SEND_STALL_MIN_DURATION_MS
    ) {
      return;
    }
    // Already closed or reconnecting: the timeouts are explained and recreating
    // the socket adds nothing.
    if (!this.socket || this.isDiscarded || this.restartRequested) {
      return;
    }
    // Silenced before the async work so concurrent rejections cannot each start
    // their own episode. handleSendStall lowers this again when the restart
    // turns out to be merely deferred rather than decided.
    this.sendStallSilentUntil = Number.POSITIVE_INFINITY;
    void this.handleSendStall(Date.now() - this.sendStallStreakStartedAt);
  }

  // True while the episode this handler was launched for is still the live one.
  // Every await below is a window in which WhatsApp can drop and remake the socket
  // on its own: the replacement gets a fresh keystore and clears the breaker, and
  // acting on the old verdict afterwards means reporting a stall on a healthy
  // connection and asking the handler to discard it.
  private isStallEpisodeCurrent(generation: number): boolean {
    return (
      !this.isDiscarded &&
      this.isCurrentGeneration(generation) &&
      this._consecutiveSendTimeouts >= SEND_STALL_THRESHOLD
    );
  }

  private async handleSendStall(streakMs: number) {
    const generation = this.socketGeneration;
    let action: "restart" | "suppressed" = "suppressed";
    let until: string | undefined;

    if (config.baileys.sendStallRestartEnabled) {
      try {
        const mayRestart = await canRestartAfterStall(this.phoneNumber);
        if (!this.isStallEpisodeCurrent(generation)) {
          // Recovered while Redis was answering. Lower the silence so a fresh
          // episode on the new socket can report itself.
          this.sendStallSilentUntil = 0;
          return;
        }
        if (mayRestart) {
          if (!BaileysConnection.claimStallRestartSlot()) {
            // Process-wide cooldown: another connection restarted moments ago.
            // That is a scheduling delay, not a verdict, so this episode is
            // neither reported nor closed — the next send attempt re-evaluates
            // once the slot frees. Reporting "suppressed" here would turn a
            // fleet-wide stall into 8 alerts and 1 recovery.
            this.sendStallSilentUntil = 0;
            return;
          }
          action = "restart";
        } else {
          const allowedAt = await nextRestartAllowedAt(this.phoneNumber);
          if (!this.isStallEpisodeCurrent(generation)) {
            this.sendStallSilentUntil = 0;
            return;
          }
          until = allowedAt ? new Date(allowedAt).toISOString() : undefined;
          // Reconsider once the backoff we just advertised as `until` expires.
          // Staying silent past it would make that timestamp a lie: the breaker
          // rejects every send without touching the socket, so nothing else
          // would ever bring this connection back up for review.
          this.sendStallSilentUntil = allowedAt ?? 0;
        }
      } catch (error) {
        logger.error(
          "[%s] [sendStall] backoff lookup failed: %s",
          this.phoneNumber,
          errorToString(error),
        );
        // Re-arm. maybeReportSendStall raised the silence to Infinity before
        // launching this, on the assumption that it would come back with a
        // verdict; a Redis blip is not a verdict, and leaving it there means no
        // later send can ever re-evaluate — the breaker rejects them all
        // without touching the socket, so this connection would stay muted for
        // the life of the socket with the restart it needed never requested.
        // A cooldown rather than 0, so a Redis outage cannot turn every
        // rejected send into its own webhook.
        this.sendStallSilentUntil = Date.now() + SEND_STALL_RESTART_COOLDOWN_MS;
      }
    }

    logger.warn(
      "[%s] [sendStall] detected consecutiveTimeouts=%d streakMs=%d action=%s",
      this.phoneNumber,
      this._consecutiveSendTimeouts,
      streakMs,
      action,
    );

    this.sendToWebhook({
      event: "connection.update",
      data: {
        error: "send_stall_detected",
        sendStall: {
          consecutiveTimeouts: this._consecutiveSendTimeouts,
          stalledForMs: streakMs,
          action,
          ...(until && { until }),
        },
      },
    });

    if (action !== "restart") {
      return;
    }

    this.restartRequested = true;
    try {
      await recordStallRestart(this.phoneNumber);
    } catch (error) {
      logger.error(
        "[%s] [sendStall] failed to record restart: %s",
        this.phoneNumber,
        errorToString(error),
      );
    }
    // Last gate before the socket is actually discarded, and the one that matters
    // most: the webhook above only reports, this destroys a live connection.
    if (!this.isStallEpisodeCurrent(generation)) {
      this.restartRequested = false;
      this.sendStallSilentUntil = 0;
      return;
    }
    // Through the handler, never inline: the replacement socket has to
    // participate in the handler's per-number inFlightOps lock. See
    // connectionsHandler.spawnConnection.
    this.requestRestart?.(
      `send stall: ${this._consecutiveSendTimeouts} consecutive timeouts over ${streakMs}ms`,
    );
  }

  // Process-wide, not per-connection: the point is to keep a fleet-wide stall
  // from reconnecting every affected socket at the same instant.
  //
  // performance.now(), not Date.now(), for the same reason the coordinator uses
  // it for lastRebalanceReleaseAt: this is a pure elapsed-time gate, and an NTP
  // step backwards would otherwise suppress every restart until wall clock
  // caught up. -Infinity because performance.now() starts near zero at boot, so
  // a 0 sentinel would silently rate-limit the first restart away.
  private static lastStallRestartAt = Number.NEGATIVE_INFINITY;

  private static claimStallRestartSlot(): boolean {
    const now = performance.now();
    if (
      now - BaileysConnection.lastStallRestartAt <
      SEND_STALL_RESTART_COOLDOWN_MS
    ) {
      return false;
    }
    BaileysConnection.lastStallRestartAt = now;
    return true;
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
    return this.relayWithTimeout("deleteMessage", () =>
      this.safeSocket().sendMessage(jid, { delete: key }),
    );
  }

  editMessage(
    jid: string,
    key: proto.IMessageKey,
    messageContent: AnyMessageContent,
  ) {
    return this.relayWithTimeout("editMessage", () =>
      this.safeSocket().sendMessage(jid, {
        ...messageContent,
        edit: key,
      } as AnyMessageContent),
    );
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

    // Recorded here, before the branches below — several of which return early
    // (reconnect, wrong number, lease yield) and never reach the assignment near
    // the bottom of this method. Leaving it to that one means a socket that just
    // closed keeps reporting `open`, and since the reconnect path creates a
    // replacement socket on its way out, `isOpen` (and the health endpoint built
    // on it) would answer `connected: true` for the whole handshake. The
    // assignment below still runs: it applies the qr/isOnline rewrites, which
    // describe what the client is told, not what the socket is doing.
    if (connection) {
      this.connectionState = connection;
    }

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
        // warn, not debug: production typically runs at LOG_LEVEL=warn and
        // the close reason is the one datum that explains a reconnect loop
        // (e.g. the server rejecting every handshake with stream:error 503).
        logger.warn(
          "[%s] [handleConnectionUpdate] connection closed (statusCode=%s, message=%s), reconnecting (attempt %d)",
          this.phoneNumber,
          String(statusCode ?? "unknown"),
          message ?? "",
          this.reconnectCount + 1,
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

    if (data.connection) {
      this.connectionState = data.connection;
    }

    if (data.connection === "open") {
      this.reconnectCount = 0;
      // A fresh socket means a fresh keystore and a fresh mutex map, so
      // whatever was wedged is gone. Without this reset the circuit breaker
      // stays open across an in-place reconnect (the connection object
      // survives a socket drop) and the connection would answer 503 forever —
      // worse than the stall it was built to contain, since the original bug
      // at least cleared itself when WhatsApp dropped the socket.
      //
      // Gated on the ORIGINAL event, not on `data.connection`: `isOnline` was
      // rewritten into `data` a few lines above, and `isOnline` is a presence
      // echo on the socket we already have. `sendPresenceUpdate("available")`
      // emits one, and POST /connections calls exactly that when it reuses a
      // live connection — which is what the Chatwoot health check does every
      // five minutes. Resetting on that would hand a still-wedged socket a
      // clean breaker on a timer, and every reset lets another batch of sends
      // queue behind the same stuck mutex.
      if (connection === "open") {
        this.clearSendStallState();
      }
      // Any healthy open wipes the quarantine strike history — the backoff
      // must reflect CONSECUTIVE failed cycles, not lifetime totals. Not
      // awaited (the open path must not block on it), rejection logged.
      clearQuarantine(this.phoneNumber).catch((clearError) => {
        logger.warn(
          "[%s] [handleConnectionUpdate] clearQuarantine failed; background claims may skip this phone until the stale entry expires (error=%s)",
          this.phoneNumber,
          errorToString(clearError),
        );
      });
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

    this.trackOutgoingAck(data);

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

  // The only end-to-end proof that sending works, short of injecting a probe
  // message: WhatsApp acknowledging one of OUR messages. markTraffic() fires
  // before the send and on inbound traffic, so it stays fresh while sending is
  // dead — it cannot serve as this signal. A resolved socket.sendMessage proves
  // the keystore mutex was free, not that the server took the message.
  //
  // "Ours" means submitted through THIS socket, which `fromMe` does not say: the
  // same account sending from the phone or another companion device produces
  // `fromMe` keys too, and none of those went through this connection's keystore
  // mutex. Accepting them would let a busy account keep a wedged connection
  // reporting `ok` — the store's own phone answering customers by hand is exactly
  // the situation this signal is supposed to see through.
  private trackOutgoingAck(data: BaileysEventMap["messages.update"]) {
    const acked = data.some(
      ({ key, update }) =>
        this.isOurSubmittedKey(key) &&
        update?.status !== undefined &&
        update.status !== null &&
        update.status >= WAMessageStatus.SERVER_ACK,
    );
    if (acked) {
      this._lastOutgoingAckAt = Date.now();
    }
  }

  // The group half of the same signal. A group message's delivery and read
  // acknowledgements arrive on message-receipt.update, not messages.update, so a
  // connection that only ever writes to groups would sit at `unknown` forever no
  // matter how many recipients confirmed — an inbox whose send path is provably
  // working, reported as never observed.
  private trackOutgoingReceiptAck(
    data: BaileysEventMap["message-receipt.update"],
  ) {
    const acked = data.some(
      ({ key, receipt }) =>
        this.isOurSubmittedKey(key) &&
        (receipt?.receiptTimestamp != null ||
          receipt?.readTimestamp != null ||
          receipt?.playedTimestamp != null),
    );
    if (acked) {
      this._lastOutgoingAckAt = Date.now();
    }
  }

  private isOurSubmittedKey(key: WAMessageKey | undefined | null): boolean {
    return (
      key?.fromMe === true &&
      key.id !== undefined &&
      key.id !== null &&
      this.submittedMessageIds.has(key.id)
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
    this.trackOutgoingReceiptAck(data);
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
      // abort() first and SYNCHRONOUSLY: with an await between the decision
      // and the abort, a socket event landing in that window (e.g. a late
      // "open") races a connection this guard already condemned. The strike
      // lands after — still ahead of any background re-claim, because the
      // abort does not release the lease; it only expires by TTL seconds
      // from now.
      this.abort();
      let quarantine: QuarantineState | null = null;
      try {
        quarantine = await recordStrike(this.phoneNumber);
      } catch (error) {
        logger.warn(
          "[%s] [handleReconnecting] failed to record quarantine strike: %s",
          this.phoneNumber,
          errorToString(error),
        );
      }
      logger.warn(
        "[%s] [handleReconnecting] Reconnect count exceeded 10, aborting reconnection (auth state preserved)%s",
        this.phoneNumber,
        quarantine
          ? `; quarantined until ${new Date(quarantine.nextRetryAt).toISOString()} (strike ${quarantine.strikes})`
          : "",
      );
      this.sendToWebhook({
        event: "connection.update",
        data: {
          error: "reconnect_loop_detected",
          ...(quarantine && {
            quarantine: {
              strikes: quarantine.strikes,
              until: new Date(quarantine.nextRetryAt).toISOString(),
            },
          }),
        },
      });
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
