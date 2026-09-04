import type { Boom } from "@hapi/boom";
import makeWASocket, {
  type AnyMessageContent,
  type AuthenticationState,
  type BaileysEventMap,
  Browsers,
  type Chat,
  type ChatModification,
  type ConnectionState,
  DisconnectReason,
  isJidGroup,
  type LIDMapping,
  type MessageReceiptType,
  makeCacheableSignalKeyStore,
  type ParticipantAction,
  proto,
  type UserFacingSocketConfig,
  type WAConnectionState,
  type WAMessage,
  type WAMessageKey,
  WAMessageStatus,
  type WAPresence,
} from "@whiskeysockets/baileys";
import { toDataURL } from "qrcode";
import { decryptMessageEdit } from "@/baileys/helpers/decryptMessageEdit";
import { downloadMediaFromMessages } from "@/baileys/helpers/downloadMediaFromMessages";
import { fetchBaileysClientVersion } from "@/baileys/helpers/fetchBaileysClientVersion";
import {
  type BaileysHistoryFramePayload,
  chatLidPnPairs,
  exhaustedChats,
  groupNames,
  historyFrames,
  lidPnIndex,
  restoreAddressing,
  unresolvedLids,
} from "@/baileys/helpers/historySync";
import {
  isTxMutexTimeout,
  txMutexTimeoutKey,
} from "@/baileys/helpers/isTxMutexTimeout";
import {
  messageAuthorJids,
  messageEditSenderCandidates,
  type OwnJids,
} from "@/baileys/helpers/messageEditSenders";
import {
  MESSAGE_SECRET_TTL_SECONDS,
  type MessageSecretEntry,
  recallMessageSecret,
  rememberMessageSecrets,
} from "@/baileys/helpers/messageSecretStore";
import { normalizeBrazilPhoneNumber } from "@/baileys/helpers/normalizeBrazilPhoneNumber";
import { preprocessAudio } from "@/baileys/helpers/preprocessAudio";
import {
  decodeEditedMessage,
  messageTimestampSeconds,
  orderEditsOldestFirst,
  ownMessageSecret,
  replaceInnerContent,
  type SecretMessageEdit,
  secretMessageEdit,
} from "@/baileys/helpers/secretEncryptedMessageEdit";
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
  clearSendStall,
  nextRestartAllowedAt,
  recordRestart as recordStallRestart,
  restoreState as restoreSendStallState,
  type SendStallState,
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
// Hard ceiling on sends in flight at once, and it is a queue bound rather than a
// stall detector. The breaker only opens after three COMPLETED timeouts, which
// is one whole BAILEYS_SEND_TIMEOUT_MS away: everything arriving inside that
// first window passes an empty counter and parks behind the wedged mutex. Those
// operations are not cancellable -- withTimeout stops us waiting, nothing stops
// them running -- so if the mutex frees while the socket is still alive they all
// fire at once, hours late, at a real customer, while their callers have long
// since timed out and retried. That burst is the failure this whole file is
// shaped around, and until this cap its size was "however many sends arrived in
// 45 seconds", not three.
//
// Generous on purpose: the keystore transaction serialises the relay anyway, so
// concurrency past a handful buys only parallel media uploads, and a healthy
// connection to one WhatsApp account rarely has eight sends in the air.
const MAX_IN_FLIGHT_SENDS = 8;
const SEND_STALL_MIN_DURATION_MS = 90_000;
// Spreads restarts across a fleet-wide event: with several inboxes stalled at
// once, they recover over minutes instead of reconnecting simultaneously
// against the same IP.
const SEND_STALL_RESTART_COOLDOWN_MS = 30_000;
// How many recently submitted WhatsApp ids to remember for ack matching. An ack
// follows its send within seconds, so this is generous; the cap is what keeps a
// long-lived busy connection from growing the set without bound.
const SUBMITTED_ID_HISTORY = 500;
// Acknowledgements for `fromMe` ids we have not (yet) submitted. Smaller than the
// submitted history because it only has to cover the gap between WhatsApp
// acknowledging and socket.sendMessage resolving, and because most entries here
// are genuinely not ours -- messages the operator sent from the phone.
const UNMATCHED_ACK_HISTORY = 100;

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

/**
 * An edit's place in its target's history: when it was made, then which event
 * brought it, then where it sat inside that event. Each term only ever
 * separates a tie in the one before it.
 *
 * The third exists because one batch can carry two edits of the same message
 * stamped in the same second, and they do not necessarily take the same route
 * out: the newer can decrypt in place while the older falls back to the stored
 * sender forms and leaves as an update. Without a rank the older one would not
 * look superseded, and would revert the message.
 */
interface EditPosition {
  at: number;
  seq: number;
  rank: number;
}

interface UnresolvedEdit {
  message: WAMessage;
  edit: SecretMessageEdit;
  position: EditPosition;
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
  private onUnrecoverable: (() => void) | null;
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
  // Identifies the keystore of the live socket, so events from a replaced one
  // are ignored. Set only once makeWASocket has returned.
  private currentTxToken: object | null = null;
  // Which keystore key the patched transaction reported as wedged. Its release
  // is the only proof the mutex freed itself that arrives while the breaker is
  // open and nothing can reach the socket.
  private wedgedTxKey: string | null = null;
  // Sends admitted to the current socket and not yet settled. Reset with the
  // socket, because a parked send never settles and its decrement never comes.
  private inFlightSends = 0;
  // The backoff state as it was before this episode's strike, so a restart
  // cancelled after the fact can undo exactly its own increment.
  // "The session stopped existing", as opposed to "this socket was replaced".
  // isDiscarded conflates the two -- discard() sets it for an ordinary
  // replacement (a forceRestart connect, the lease fence, a respawn) just as
  // logout and close do for a teardown -- and the send-stall rollback has to
  // tell them apart: a destroyed session's backoff key must go, a replaced
  // socket's must keep whatever history the phone genuinely earned.
  private sessionEnded = false;
  // Serializes the send-stall verdicts against each other. See reportSendStall.
  private stallReportChain: Promise<unknown> = Promise.resolve();
  // One delivery chain per edited message. See enqueueEditDelivery.
  private editDeliveries = new Map<string, Promise<void>>();
  // Secrets this connection has taken in but not yet filed. See
  // beginSecretIntake.
  private secretIntake: Promise<unknown> = Promise.resolve();
  // When each edited message was last edited, as far as this connection has
  // delivered. See claimEditPosition.
  private editedAt = new Map<string, EditPosition>();
  // Increments once per event this connection takes in, read synchronously at
  // the top of each handler. It is the tie-break for edits stamped in the same
  // second: the timestamp cannot separate them, but the order WhatsApp handed
  // them to us can, and that order is only knowable before the handler starts
  // awaiting things.
  private eventSeq = 0;
  private stallStrikeRollback:
    | { previous: SendStallState | null; ttlMs: number | null; wrote: string }
    | undefined;
  // When each keystore key last gave up acquiring, and when it last released.
  // Both are needed to tell "the wedge is still there" from "it let go while the
  // failure was still on its way to us". Keyed by the handful of distinct
  // keystore keys a socket ever uses, and reset with the socket.
  private txTimeoutAt = new Map<string, number>();
  private txReleasedAt = new Map<string, number>();
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
  private unmatchedAckIds = new Map<string, number>();

  constructor(phoneNumber: string, options: BaileysConnectionOptions) {
    this.phoneNumber = phoneNumber;
    this.clientName = options.clientName || "Chrome";
    this.webhookUrl = options.webhookUrl;
    this.webhookVerifyToken = options.webhookVerifyToken;
    this.onConnectionClose = options.onConnectionClose || null;
    this.requestLogout = options.requestLogout ?? null;
    this.requestRestart = options.requestRestart ?? null;
    this.onUnrecoverable = options.onUnrecoverable ?? null;
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
    // The ack may have beaten the id here. Claiming it now is the difference
    // between "we have never seen this connection deliver anything" and the
    // truth, on the send whose own response was the slow part.
    const ackedAt = this.unmatchedAckIds.get(messageId);
    if (ackedAt !== undefined) {
      this.unmatchedAckIds.delete(messageId);
      // Never backwards. A parked ack can be claimed long after it arrived --
      // the send it belongs to may have taken hours to resolve -- and other
      // sends acknowledge in the meantime. Writing the older timestamp over the
      // newer one makes /health report a send path staler than it is, which for
      // a signal whose whole job is "when did WhatsApp last confirm anything"
      // is the one direction that raises a false alarm.
      this._lastOutgoingAckAt = Math.max(this._lastOutgoingAckAt ?? 0, ackedAt);
    }
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

  // True between asking for a restart and any evidence of recovery. The handler
  // re-reads it after draining the per-number slot: a restart that queued behind
  // an unrelated operation must not kill a socket that recovered while it waited.
  get restartPending(): boolean {
    return this.restartRequested;
  }

  get isOpen(): boolean {
    return this.connectionState === "open" && this.socket !== null;
  }

  // "unknown" is a first-class answer, not a fallback: a connection nobody
  // writes to can be wedged for hours and still look perfect, and reporting it
  // as healthy is worse than admitting we have not observed a send.
  get sendState(): "unknown" | "ok" | "degraded" | "stalled" {
    // Same gate as assertCanSend, and for the same reason: "stalled" is what
    // stalledConnectionCount and the operator read as "up but mute". A socket
    // that is not open yet is an ordinary outage, and its failing sends are
    // honestly reported as `degraded` rather than as the fault they are not.
    if (this._consecutiveSendTimeouts >= SEND_STALL_THRESHOLD && this.isOpen) {
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
  private handleTxEvent(
    token: object,
    event: {
      phase: "acquired" | "released" | "stalled" | "timeout";
      key: string;
      waitedMs: number;
      heldMs?: number;
      originStack?: string;
      stillLocked?: boolean;
    },
  ) {
    // Each socket's keystore closes over its own token. A socket we replaced can
    // still emit here -- its wedged transaction releases whenever the download it
    // was waiting on finally dies -- and reading that as news about the live
    // socket is the same mistake the generation stamp exists to prevent.
    if (token !== this.currentTxToken) {
      return;
    }
    if (event.phase === "acquired") {
      return;
    }
    if (event.phase === "released") {
      // Recorded for every key, armed or not: the release that matters most is
      // the one that arrives BEFORE we know which key to watch, while the
      // acquisition's Boom is still travelling up the send path.
      this.txReleasedAt.set(event.key, Date.now());
      // The one signal that can close the breaker without a new socket once the
      // wedge starts reporting itself through mutex timeouts. Every abandoned
      // send then rejects with E_TX_MUTEX_TIMEOUT, which recordLateSettle
      // deliberately refuses to read as recovery, and an open breaker means no
      // send reaches the socket again -- so the ordinary success path that would
      // clear it can never run. With BAILEYS_SEND_STALL_RESTART_ENABLED off (the
      // default, and the whole of the diagnostic rollout) nothing else clears it
      // either, and the connection answers 503 for the life of a socket whose
      // mutex has been free for hours.
      //
      // Keyed, because a release on any other key proves nothing about the one
      // that is wedged: the mutexes live in a per-key map.
      if (this.wedgedTxKey !== null && event.key === this.wedgedTxKey) {
        if (this._consecutiveSendTimeouts > 0) {
          logger.warn(
            "[%s] [keystoreTx] wedged key released, closing the breaker key=%s heldMs=%s afterTimeouts=%d",
            this.phoneNumber,
            event.key,
            event.heldMs ?? "-",
            this._consecutiveSendTimeouts,
          );
        }
        this.clearSendStallState();
      }
      return;
    }
    if (event.phase === "timeout") {
      this.txTimeoutAt.set(event.key, Date.now());
    }
    // Deliberately NOT the source of wedgedTxKey. `stalled` fires for whatever
    // key happens to be held past BAILEYS_TX_HOLD_WARN_MS, which is regularly an
    // unrelated one -- a group transaction, a lid-mapping write. Letting it
    // overwrite the key would make that transaction's release close the breaker
    // while the send mutex is still wedged, readmitting a batch into the queue
    // the breaker exists to bound. Only our own send's failure names the key
    // that is actually blocking sends.
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
    //
    // Forward only, and that is the half that bites. The epoch is a global INCR
    // per phone, so it only ever grows -- but an explicit operation that acquired
    // an OLDER one can still be parked before the handler when a newer one
    // replaces the socket, and it arrives here afterwards carrying its own. Let
    // it through and a live connection stamps events the client discards as
    // stale while the coordinator renews an epoch nobody publishes: the channel
    // simply stops updating. The rest of its options still apply -- it is a real
    // reconfiguration, just no longer the owner of record. A null carries no
    // epoch information at all and must not erase one either.
    if (
      options.leaseEpoch !== undefined &&
      (this.leaseEpoch === null ||
        (options.leaseEpoch !== null && options.leaseEpoch >= this.leaseEpoch))
    ) {
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

    // Identity for the keystore this socket is about to be built on, so a
    // transaction event can be told from one emitted by a socket we replaced.
    // A token rather than the generation counter because the counter is bumped
    // only after makeWASocket succeeds, and this closure has to exist before it.
    const txToken = {};
    const socketOptions: UserFacingSocketConfig = {
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(guardedKeys, logger),
      },
      markOnlineOnConnect: false,
      logger: baileysLogger,
      browser: Browsers.windows(this.clientName),
      syncFullHistory: this.syncFullHistory,
      // The lib's default is `syncType !== FULL`, which drops the very dump
      // `syncFullHistory` asks the phone for: WhatsApp sends the FULL
      // notification and Baileys discards it before decoding, so the option
      // buys a bootstrap and an offline replay and nothing deeper. Measured on
      // a real pairing: six notifications sent (one per syncType), two
      // delivered. Accepting FULL is therefore what `syncFullHistory: true`
      // was always supposed to mean; with it off the default stands and the
      // deep archive is refused, which is the privacy behaviour we want.
      shouldSyncHistoryMessage: ({ syncType }) =>
        this.syncFullHistory ||
        syncType !== proto.HistorySync.HistorySyncType.FULL,
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
        onTransactionEvent: (event) => this.handleTxEvent(txToken, event),
      },
    };

    try {
      this.socket = makeWASocket(socketOptions);
      // An existing session hands back its account JIDs immediately. Read them
      // now so they outlive the socket; see ownJidsSeen.
      this.ownJids();
      this.currentTxToken = txToken;
      // The new socket carries a new keystore and a new mutex map. Bumping here
      // (and only here) is what makes every stamped watchdog reading below
      // mean "observed on the socket that is live right now".
      this.socketGeneration += 1;
      // The breaker counts refusals by ONE socket's keystore mutex, and this is a
      // different mutex, so the streak dies with the socket that produced it. Two
      // things go wrong when it survives. The count carries, so a single timeout
      // during the new handshake (safeSocket only requires a socket object, and the
      // replacement has one before `open` arrives) opens the breaker on a connection
      // that was merely reconnecting, and every later request gets the stall-specific
      // 503 that tells the caller NOT to mark the channel down. Worse, the streak
      // CLOCK carries: sendStallStreakStartedAt still points at the old socket, so
      // the 90s floor — the guard whose whole job is to stop one hiccup from
      // recreating a healthy socket — is already satisfied and the watchdog restarts
      // on the first timeout. Clearing on `open` alone is too late for both.
      this.clearSendStallState();
      // The id history belongs to the socket that submitted them. A delayed
      // receipt for a message the PREVIOUS socket sent would otherwise stamp
      // lastOutgoingAckAt now, presenting end-to-end evidence about a
      // replacement that may itself be wedged and has sent nothing.
      this.submittedMessageIds.clear();
      this.unmatchedAckIds.clear();
      this.inFlightSends = 0;
      // Both belong to the keystore that just went away.
      this.txTimeoutAt.clear();
      this.txReleasedAt.clear();
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
      // Not onConnectionClose here any more: every caller now handles the
      // rejection and does its own, better cleanup (spawnConnection removes the
      // entry it just registered and discards; the reconnect path below aborts).
      // Firing it as well would double-notify and, on the reconnect path, evict
      // through two routes at once.
      // Rethrown, not swallowed. Resolving here reports a connect that built
      // nothing as success: spawnConnection's cleanup never runs, an automatic
      // restart never reports the failure so the lease is never released, and
      // POST /restart answers 202 for a socket that does not exist. Every caller
      // above already handles a rejection -- the claim cycle releases its lease
      // on one, and the handler removes the entry it had just registered.
      throw error;
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
        "onMessagesUpdate",
        this.onMessagesUpdate,
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
    // Inert from here on. close() is the terminal teardown -- logout, and a
    // remote `loggedOut` -- and it is where the auth state is destroyed, but it
    // was leaving isDiscarded false. Anything awaiting across it (the send-stall
    // watchdog writing its strike is the one that bites) then read a connection
    // that still looked live and asked the handler to rebuild a socket for a
    // session that no longer has credentials: a fresh QR pairing conjured out of
    // a logout. Every other teardown path marks itself; this one has to as well.
    this.isDiscarded = true;
    // Reached without logout() too, on a remote `loggedOut`.
    this.sessionEnded = true;
    this.stopGroupActivityFlush();
    if (this.clearOnlinePresenceTimeout) {
      clearTimeout(this.clearOnlinePresenceTimeout);
      this.clearOnlinePresenceTimeout = null;
    }
    await this.clearAuthState?.();
    this.clearAuthState = null;
    // Here, not only in the coordinator's logout: this is where the session
    // stops existing, and every destructive path goes through it -- admin
    // logoutAll, the wrong-number requestLogout, a remote `loggedOut` close.
    // The backoff key is per phone number and lives 24h, so without this the
    // next pairing on that number inherits the discarded session's restart
    // suppression and its watchdog is disarmed for a stall it never caused.
    await clearSendStall(this.phoneNumber).catch((error) => {
      logger.warn(
        "[%s] [close] failed to clear send-stall backoff: %s",
        this.phoneNumber,
        errorToString(error),
      );
    });
    this.socket = null;
    this.reconnectCount = 0;
    this.connectionReplacedTimestamps = [];
    this.onConnectionClose?.();
  }

  async logout() {
    // Terminal for the SESSION, not just for this socket: close() below destroys
    // the auth state. Marked before the first await so anything crossing it (the
    // send-stall rollback is the one that bites) sees a session that is ending.
    this.sessionEnded = true;
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
    options?: {
      quoted?: WAMessage;
      messageId?: string;
      // See relayWithTimeout: fires when this send is later proved never to have
      // reached WhatsApp, long after its caller was answered.
      onLateDefinitiveFailure?: () => void;
    },
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
        //
        // Bounded, and deliberately NOT by the send deadline. This work is local
        // and legitimately slow, so charging it to the send budget would open the
        // breaker and recreate a socket that never refused anything. But it runs
        // BEFORE that deadline is armed, so unbounded it defeats the guarantee
        // sendTimeoutMs < PROXY_REQUEST_TIMEOUT_MS exists to give: the proxy would
        // cut first and answer its own generic 504, and the worker would never
        // reach the code that releases the idempotency lock or counts the stall.
        //
        // Expressed as a signal rather than a race, because a race only stops us
        // waiting: the abandoned conversion would keep its slot in the worker
        // pool's pending map with a promise nobody can ever settle. On expiry the
        // catch below sends the original buffer, which is exactly what already
        // happens when ffmpeg is missing.
        const preprocessDeadline = AbortSignal.timeout(
          config.baileys.audioPreprocessTimeoutMs,
        );
        [messageContent.audio, waveformProxy] = await Promise.all([
          preprocessAudio(
            originalAudio,
            // NOTE: Use lower quality for ptt messages for more realistic quality.
            messageContent.ptt ? "ogg-low" : "mp3-high",
            preprocessDeadline,
          ),
          messageContent.ptt
            ? preprocessAudio(originalAudio, "wav", preprocessDeadline)
            : null,
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
    // Again, here, and not only at the top of this method. The audio work above
    // can await for up to the preprocessing budget, and a reconnect inside that
    // window clears submittedMessageIds along with the socket that owned them --
    // so this send would go out on the replacement carrying a reserved id the
    // history no longer holds, and every ack for it would be rejected as not
    // ours. Registering it against the socket that is about to carry it is what
    // makes the history mean what it says.
    if (options?.messageId) {
      this.trackSubmittedId(options.messageId);
    }
    const sent = await this.relayWithTimeout(
      "sendMessage",
      () =>
        this.safeSocket().sendMessage(jid, messageContent, {
          waveformProxy,
          quoted: options?.quoted,
          ...(options?.messageId ? { messageId: options.messageId } : {}),
        }),
      options?.onLateDefinitiveFailure,
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
    if (this.inFlightSends >= MAX_IN_FLIGHT_SENDS) {
      // Same guard the breaker branch below carries, and for the same reason. A
      // socket that closes with its sends still unresolved keeps every one of
      // them holding a slot -- the slot belongs to the operation, not to our wait
      // on it -- so the cap is exactly what a send lands on during an ordinary
      // outage. Answering `stalled` there tells the caller the connection is up
      // and must NOT be marked down, which is the opposite of true and costs it
      // the reconnect it needed.
      if (!this.isOpen) {
        throw new BaileysNotConnectedError();
      }
      logger.warn(
        "[%s] [sendStall] refusing send: %d already in flight",
        this.phoneNumber,
        this.inFlightSends,
      );
      // The same answer as an open breaker, and for the same reason: the
      // connection is not accepting sends right now and must NOT be marked down.
      // Deliberately without maybeReportSendStall -- a full queue is backpressure,
      // not evidence of a wedge, and it must not spend a restart.
      throw new BaileysSendStalledError();
    }
    if (this._consecutiveSendTimeouts < SEND_STALL_THRESHOLD) {
      return;
    }
    // A stall is a claim about a socket that is UP, and maybeReportSendStall
    // already refuses to report one otherwise. The refusal has to agree: the
    // stall-specific 503 tells the caller the connection is up and must NOT be
    // marked down, which is precisely wrong for a socket still handshaking, and
    // it would cost the caller the reconnect it needed. Three concurrent sends
    // expiring during a slow handshake is all it takes to reach the threshold.
    if (!this.isOpen) {
      throw new BaileysNotConnectedError();
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
    // Called when a send that already answered its caller is LATER proved never
    // to have reached WhatsApp. Only the mutex-acquire timeout proves that: its
    // waiter never entered txStorage.run, so it read nothing, wrote nothing and
    // relayed nothing. Everything else that settles late is still ambiguous.
    onLateDefinitiveFailure?: () => void,
  ): Promise<T> {
    this.assertCanSend();
    // Captured BEFORE the send starts, and carried into every callback below.
    // A reconnect mid-send replaces the socket while these deadlines keep
    // running against a keystore that no longer exists: unstamped, three of
    // them expiring after the swap would open the breaker on a healthy
    // replacement that had not refused a single send.
    const generation = this.socketGeneration;
    this.inFlightSends += 1;
    try {
      const result = await withTimeout(
        operation,
        config.baileys.sendTimeoutMs,
        fn,
        (error, value) => {
          // Before recordLateSettle, which drops a discarded or superseded
          // connection on the way in. That guard is right for the breaker's
          // bookkeeping and wrong here: "this send never entered the transaction"
          // stays true whether or not the socket that made it still exists, and
          // it is the caller's message that is waiting on the answer.
          if (error !== undefined && isTxMutexTimeout(error)) {
            onLateDefinitiveFailure?.();
          }
          // The slot belongs to the OPERATION, not to our wait on it. A timed-out
          // send is still parked in the mutex and still the thing the cap exists
          // to bound, so its slot is only given back here, when the underlying
          // promise actually settles.
          this.releaseInFlight(generation);
          this.recordLateSettle(operation, generation, error, value);
        },
      );
      this.releaseInFlight(generation);
      this.recordSendSuccess(generation);
      return result;
    } catch (error) {
      // Both are refusals the breaker must count, and which one arrives first is
      // decided by config, not by the failure: BAILEYS_TX_ACQUIRE_TIMEOUT_MS can be
      // set below BAILEYS_SEND_TIMEOUT_MS, and then the wedge reports itself before
      // our own deadline does. Counting only OperationTimeoutError there would leave
      // the detector blind in exactly the configuration that detects the wedge
      // fastest. recordLateSettle already reads this error as wedge evidence; this
      // is the same reading on the path that runs first.
      if (error instanceof OperationTimeoutError) {
        // Deliberately no release: onLateSettle above owns it now. Holding the
        // slot is the whole correction -- an abandoned send keeps running, and
        // admitting a replacement for it is how the queue grew past the ceiling.
        this.recordSendTimeout(operation, generation);
        throw error;
      }
      this.releaseInFlight(generation);
      if (isTxMutexTimeout(error) && this.isCurrentGeneration(generation)) {
        // Gated together, and the gate has to come first. recordSendTimeout drops
        // a stale generation on its own, but noteMutexWedge would already have
        // stamped a replaced socket's key onto the live watchdog -- the same
        // ordering the late-settlement path gets right.
        this.noteMutexWedge(error);
        this.recordSendTimeout(operation, generation, "mutex-wedge");
      }
      throw error;
    }
  }

  // Only for the socket that admitted it. A parked send may settle long after
  // its socket was replaced, and letting that decrement land would drift the
  // replacement's count downwards; the counter is reset with the socket instead.
  private releaseInFlight(generation: number) {
    if (this.isCurrentGeneration(generation)) {
      this.inFlightSends -= 1;
    }
  }

  // True while the argument still describes the live socket. A settlement from
  // an earlier generation is not wrong, it is about a keystore that has since
  // been thrown away, and the watchdog's whole subject is the current one.
  // Records which keystore key our sends are blocked on, from the Boom the
  // patched transaction throws. This arms the release-based recovery in
  // handleTxEvent, and it arms it in exactly the configuration that needs it:
  // with BAILEYS_TX_ACQUIRE_TIMEOUT_MS at 0 no send ever rejects this way, but
  // then nothing converts a parked send into a rejection either, so the parked
  // send eventually succeeds and the ordinary late-success path closes the
  // breaker on its own.
  private noteMutexWedge(error: unknown) {
    const key = txMutexTimeoutKey(error);
    if (key === null) {
      return;
    }
    // The holder can let go in the gap between the acquisition giving up and the
    // Boom reaching here -- a few awaits up the send path. handleTxEvent saw that
    // release while wedgedTxKey was still null and rightly ignored it, and it was
    // the ONLY one that key will ever emit. Arming on it now would wait forever
    // for a second release, and with automatic restart off (the default) nothing
    // else closes the breaker: 503 for the life of a socket whose mutex is free.
    const releasedAt = this.txReleasedAt.get(key) ?? 0;
    const timedOutAt = this.txTimeoutAt.get(key) ?? 0;
    if (releasedAt >= timedOutAt && releasedAt > 0) {
      logger.warn(
        "[%s] [keystoreTx] key=%s released while its timeout was propagating; not arming",
        this.phoneNumber,
        key,
      );
      this.clearSendStallState();
      return;
    }
    this.wedgedTxKey = key;
  }

  private isCurrentGeneration(generation: number): boolean {
    return generation === this.socketGeneration;
  }

  // Clears the breaker without asserting anything about a send having landed.
  // Split out because a late REJECTION proves the operation left the mutex
  // queue (which is what the breaker counts) but proves nothing about delivery,
  // so it must not touch the health timestamps.
  private clearSendStallState() {
    this._consecutiveSendTimeouts = 0;
    this.wedgedTxKey = null;
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
    value?: unknown,
  ) {
    if (this.isDiscarded || !this.isCurrentGeneration(generation)) {
      return;
    }
    // And it does not free a queue slot either, which is the other half of why
    // this branch exists. async-mutex@0.5's withTimeout rejects the wrapper on
    // expiry but leaves the underlying acquire in the semaphore queue; it only
    // releases the ticket once the holder finally unlocks (withTimeout.js, the
    // `if (isTimeout) release()` path). So a timed-out waiter is still queued,
    // and treating its rejection as "the queue emptied" would be false.
    //
    // Deliberately not worked around. Removing the waiter means replacing that
    // acquisition with a cancellable queue of our own, inside the patch, which
    // trades a bounded cost for a much larger patch to rebase on every bump. The
    // cost is bounded: the retained waiters are a promise each, the breaker caps
    // the send-side ones at three, and draining them is an acquire-then-release
    // apiece with no work in between. It also buys something -- every drained
    // ticket releases instead of sending, so an acquire timeout is precisely what
    // stops a freed mutex from firing hours of queued sends at a real customer.
    // That burst is the failure this whole file is shaped around, and it is
    // BAILEYS_TX_ACQUIRE_TIMEOUT_MS=0 that reopens it.
    if (error !== undefined && isTxMutexTimeout(error)) {
      this.noteMutexWedge(error);
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
      // The id Baileys generated for this message, which the success path would
      // have recorded and never got to. Without it every receipt for this
      // message is rejected by isOurSubmittedKey, so lastOutgoingAckAt -- the
      // only end-to-end evidence there is, and the only one that does not come
      // from us -- stays null for precisely the send whose outcome was unknown.
      // Only reachable when the caller reserved no messageId; with one, the
      // same id was already tracked before the send left.
      const sentId = (value as { key?: { id?: string | null } } | undefined)
        ?.key?.id;
      if (sentId) {
        this.trackSubmittedId(sentId);
      }
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

  private recordSendTimeout(
    operation: string,
    generation: number,
    cause: "timeout" | "mutex-wedge" = "timeout",
  ) {
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
      "[%s] [sendStall] %s operation=%s consecutive=%d streakMs=%d",
      this.phoneNumber,
      cause,
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
    // isOpen, not "we hold a socket object": during a first connect or a slow
    // reconnect the socket exists while the handshake is still running, and sends
    // that time out in that window are an ordinary connection outage, not a wedged
    // mutex. Reporting one as a stall would tear down a socket that was on its way
    // up, and do it again on the replacement.
    if (!this.isOpen || this.isDiscarded || this.restartRequested) {
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
      // isOpen carries the entry gate across the awaits. The socket can emit
      // `close` while Redis answers, and until the reconnect builds its
      // replacement the generation and the streak both still match — so without
      // this the handler reports a send stall, spends a backoff strike and asks
      // for a restart, all for an ordinary disconnect that is already
      // reconnecting on its own.
      this.isOpen &&
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
        // Both reads together, resolved by ONE currency check. Chaining them
        // would put a second window between the checks in which the socket can
        // be replaced, and every await on this path has cost us that once.
        const [mayRestart, ownedElsewhere] = await Promise.all([
          canRestartAfterStall(this.phoneNumber),
          this.shouldYieldToLeaseOwner(),
        ]);
        if (!this.isStallEpisodeCurrent(generation)) {
          // Recovered while Redis was answering. Lower the silence so a fresh
          // episode on the new socket can report itself.
          this.sendStallSilentUntil = 0;
          return;
        }
        // The distributed fence, and this was the one socket-creating path
        // without it. Every other one consults the lease: the claim cycle
        // acquires, the explicit paths force-acquire behind a live-owner guard,
        // and the connectionReplaced kick yields through this same call. The
        // watchdog decided purely on local state, so a phone force-taken over
        // while this handler awaited Redis -- another instance acting on a
        // registry that briefly reported us dead -- would be rebuilt here under
        // a lease that is no longer ours, fighting the legitimate owner for the
        // identity until the next renew cycle noticed.
        //
        // abort() rather than a bare skip, and for the same reason the renew
        // cycle discards on this evidence: a socket for a phone somebody else
        // owns is a duplicate that is still receiving. It preserves the auth
        // state, so the owner keeps serving the identity.
        if (ownedElsewhere) {
          this.abort();
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
        //
        // Guarded like every other path out of an await here. A Redis lookup can
        // outlive the episode that started it, and an in-place reconnect keeps
        // THIS object and only bumps the generation -- so the cooldown would land
        // on the new socket's detector and mute it for a stall it never had,
        // while the `suppressed` verdict below would describe an episode that is
        // over.
        if (!this.isStallEpisodeCurrent(generation)) {
          this.sendStallSilentUntil = 0;
          return;
        }
        this.sendStallSilentUntil = Date.now() + SEND_STALL_RESTART_COOLDOWN_MS;
      }
    }

    // Reported here only when nothing more can cancel it. `action` is documented
    // as whether the socket was recreated, and everything below can still call
    // the restart off -- the final gate, the discard check, the recovery check --
    // so announcing "restart" up front tells a consumer that recovery is underway
    // when it may not be. The suppressed verdict is final the moment it is
    // decided, so it goes out now.
    if (action !== "restart") {
      this.reportSendStall(streakMs, action, until);
      return;
    }

    // Last gate before the socket is actually discarded, and the one that matters
    // most: the webhook above only reports, this destroys a live connection.
    if (!this.isStallEpisodeCurrent(generation)) {
      this.sendStallSilentUntil = 0;
      return;
    }
    this.restartRequested = true;
    // BEFORE requesting the restart, not after. requestRestart hands off to
    // connectionsHandler.connect, which runs synchronously up to its first await
    // when the per-number slot is free -- and that stretch includes discard().
    // So by the time the call returns, this connection is already discarded, and
    // recording afterwards under an isDiscarded guard would record nothing at
    // all: a phone that stalls repeatedly would bypass its own backoff and
    // recreate its socket without limit. The final gate is above, so a strike
    // here still implies a restart that was actually asked for.
    //
    // The guard stays, for the case it was written for: logout sets isDiscarded
    // before its first await, and the coordinator DELs the backoff key in its
    // finally. The store is a plain read-modify-write, so a strike straddling
    // that DEL recreates it, and the next session paired on this number inherits
    // an escalating suppression from a socket that no longer exists.
    if (!this.isDiscarded) {
      try {
        // The lease read rides along with the write rather than sitting before
        // it, so the fence ends up at the last point before requestRestart with
        // no await of ours after it. The check further up is what saves the
        // restart slot and this strike in the common case, but by now it is a
        // Redis round trip old, and a takeover landing inside that round trip
        // would leave this rebuilding the old owner's socket against the new
        // one's.
        const [{ previous, previousTtlMs, wrote }, ownedElsewhere] =
          await Promise.all([
            recordStallRestart(this.phoneNumber),
            this.shouldYieldToLeaseOwner(),
          ]);
        // The expiry travels with the value: restoring with a fresh 24h would
        // hand an old history another full day on the strength of a restart that
        // never happened.
        this.stallStrikeRollback = { previous, ttlMs: previousTtlMs, wrote };
        // Re-checked after the write: all three of these can land inside it,
        // which the guard above cannot see. Undoing is the only way back, since
        // nothing in the store fences a write against a session that has already
        // ended.
        //
        // Three ways this write can be obsolete by the time it lands, and they
        // undo differently.
        //
        // sessionEnded: a logout began, and close() DELs this key on its way
        // out, so restoring the previous episode's value would resurrect a
        // backoff for a session that no longer exists and hand it to whatever is
        // paired on this number next. Clear instead. Not isDiscarded, which a
        // concurrent POST /restart also sets: that one replaces the socket and
        // keeps the session, so wiping the phone's history there would hand it a
        // clean slate an earlier genuine stall already spent.
        //
        // ownedElsewhere: another instance force-acquired the phone. Its socket
        // is the legitimate one, so ours is a duplicate that is still receiving
        // and has to go -- and the strike goes back, because the backoff key is
        // cluster-wide and charging one for a restart we are not performing
        // would suppress the new owner's watchdog. Ranked above recovery: a
        // socket we do not own has to be given up whether or not it healed.
        //
        // !restartRequested: a late send completion or the wedged key releasing
        // cleared the stall, so the handler's own guard will veto the restart --
        // and a strike that outlives the restart it stands for suppresses the
        // NEXT genuine stall on the strength of a recovery. The connection is
        // still ours, so only THIS episode's increment is wrong.
        if (this.sessionEnded) {
          this.stallStrikeRollback = undefined;
          await clearSendStall(this.phoneNumber).catch(() => {});
          return;
        }
        if (this.isDiscarded) {
          // Replaced, not ended: something else took this socket over while the
          // strike was landing (a forceRestart connect, the lease fence). The
          // restart is off, so only THIS episode's increment is wrong.
          await this.rollBackStallStrike();
          return;
        }
        if (ownedElsewhere) {
          // Before the abort, which sets isDiscarded and would send the rollback
          // down the clear-instead branch above.
          await this.rollBackStallStrike();
          this.abort();
          return;
        }
        if (!this.restartRequested) {
          await this.rollBackStallStrike();
          return;
        }
      } catch (error) {
        logger.error(
          "[%s] [sendStall] failed to record restart: %s",
          this.phoneNumber,
          errorToString(error),
        );
        // Suppressed, not restarted anyway. The strike is what turns "restarting
        // is not curing this" into "give up and let the operator see it", so
        // without one a phone that keeps stalling gets a restart every episode
        // for as long as Redis is unreachable -- and a Redis outage is fleet-wide
        // by nature, so that is every stalled inbox reconnecting on a loop while
        // the system is already degraded. The READ side of the same outage
        // already suppresses (the backoff-lookup catch above); a failed write is
        // no different, and answering the same way keeps one outage from having
        // two behaviours depending on which call it hit.
        // Cleared unconditionally: this handler set it for an episode that is
        // now over either way, and leaving it would report restartPending on a
        // connection nobody is restarting.
        this.restartRequested = false;
        // Same guard as the lookup catch above, and for the same reason: the
        // write we were waiting on can outlive the episode, and everything below
        // belongs to that episode.
        if (!this.isStallEpisodeCurrent(generation)) {
          this.sendStallSilentUntil = 0;
          return;
        }
        // Re-armed on the cooldown rather than 0, for the same reason as the
        // lookup catch: a Redis outage must not turn every rejected send into
        // its own webhook, and leaving the silence at Infinity would mute this
        // socket for its lifetime.
        this.sendStallSilentUntil = Date.now() + SEND_STALL_RESTART_COOLDOWN_MS;
        this.reportSendStall(streakMs, "suppressed", undefined);
        return;
      }
    }

    // Through the handler, never inline: the replacement socket has to
    // participate in the handler's per-number inFlightOps lock. See
    // connectionsHandler.spawnConnection.
    this.reportSendStall(streakMs, action, until);
    this.requestRestart?.(
      `send stall: ${this._consecutiveSendTimeouts} consecutive timeouts over ${streakMs}ms`,
    );
  }

  private reportSendStall(
    streakMs: number,
    action: "restart" | "suppressed" | "cancelled" | "failed",
    until: string | undefined,
  ) {
    logger.warn(
      "[%s] [sendStall] detected consecutiveTimeouts=%d streakMs=%d action=%s",
      this.phoneNumber,
      this._consecutiveSendTimeouts,
      streakMs,
      action,
    );
    const payload: BaileysConnectionWebhookPayload = {
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
    };
    // Chained, not fired independently. These verdicts contradict each other --
    // `failed` and `cancelled` exist to retract a `restart` already announced --
    // and sendToWebhook offers no ordering: every payload runs its own retry loop
    // with backoff, so a `restart` that needed two attempts lands AFTER a
    // `failed` that went out on the first, and the consumer is left reading
    // recovery as underway on a connection that never came back. That is the one
    // reading this whole feature exists to prevent. The wait is bounded by the
    // retry policy, and a retraction arriving late in the right order beats one
    // arriving on time in the wrong one.
    //
    // The reservation is taken HERE, synchronously, and not left to
    // sendToWebhook: the chain does not enter it until a microtask, while
    // requestRestart discards this connection synchronously on the way out. The
    // handler reads inFlightWebhooks at exactly that moment to decide whether to
    // keep the old connection in drainingWebhooks, so a queued verdict that has
    // not started yet reads as nothing pending -- and a graceful shutdown landing
    // mid-restart exits without ever delivering the message that says recovery is
    // underway.
    this._inFlightWebhooks += 1;
    this.stallReportChain = this.stallReportChain
      .catch(() => {})
      .then(() => this.sendToWebhook(payload))
      .catch(() => {})
      .finally(() => {
        this._inFlightWebhooks -= 1;
      });
  }

  // The handler drains its per-number slot before re-checking whether the
  // restart is still wanted, so a recovery landing in that window vetoes it long
  // after this connection committed to it. Two things then have to be undone: the
  // strike, which would otherwise suppress the NEXT genuine stall on the strength
  // of a restart that never happened, and the verdict already sent to consumers.
  // The restart was asked for and could not rebuild anything. The strike stands
  // -- an attempt was made and it burned -- but consumers were told the socket
  // was being recreated, and nothing else would ever correct that. This is the
  // state where a human has to step in, so it has to be visible.
  reportFailedStallRestart() {
    this.reportSendStall(0, "failed", undefined);
  }

  async withdrawStallRestart(streakMs = 0) {
    this.restartRequested = false;
    await this.rollBackStallStrike();
    this.reportSendStall(streakMs, "cancelled", undefined);
  }

  // Restores exactly this episode's increment rather than deleting the key: the
  // history is per phone and lives 24h, so a delete would also wipe an earlier
  // genuine strike and hand the phone a clean slate it did not earn.
  private async rollBackStallStrike() {
    const rollback = this.stallStrikeRollback;
    this.stallStrikeRollback = undefined;
    if (rollback === undefined) {
      return;
    }
    try {
      // The same fork handleSendStall makes after its own write, for the same
      // reason: the two ways a restart gets called off undo differently. The
      // veto that lands here is issued by the handler AFTER it drains the
      // per-number slot, so an explicit logout queued ahead of the restart is
      // exactly what produces it -- and by then the auth state is gone and
      // close() has DELed this key. Restoring a previous episode's value would
      // recreate it for a session that no longer exists and hand it to whatever
      // is paired on this number next, its watchdog suppressed on the strength
      // of a socket nobody can reach.
      //
      // sessionEnded, not isDiscarded: a concurrent POST /restart produces this
      // same veto and also sets isDiscarded, but it replaced the socket and kept
      // the session. Clearing there would hand the phone a clean backoff slate
      // that an earlier genuine stall already spent, so only this episode's
      // increment comes back.
      if (this.sessionEnded) {
        await clearSendStall(this.phoneNumber);
        return;
      }
      await restoreSendStallState(
        this.phoneNumber,
        rollback.previous,
        rollback.ttlMs,
        rollback.wrote,
      );
    } catch (error) {
      logger.error(
        "[%s] [sendStall] failed to roll back strike: %s",
        this.phoneNumber,
        errorToString(error),
      );
    }
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

  async fetchMessageHistory(
    count: number,
    oldestMsgKey: proto.IMessageKey,
    oldestMsgTimestamp: number,
  ) {
    const remoteJid = await this.historyJid(oldestMsgKey.remoteJid ?? "");

    return this.safeSocket().fetchMessageHistory(
      count,
      { ...oldestMsgKey, remoteJid },
      oldestMsgTimestamp,
    );
  }

  // The chat as WhatsApp will actually answer for, which is not always the one we were
  // handed. Callers build a `@lid` address by appending the suffix to whatever id they
  // hold for the contact, so a chat that reached them by phone arrives as `<phone>@lid` --
  // an address no account answers to. WhatsApp does not reject it, it simply never
  // replies, and silence here is indistinguishable from a chat with nothing left to give:
  // the request looks answered-and-empty rather than misaddressed.
  //
  // The mapping store WhatsApp itself populates settles it, and the two lookups are
  // exactly complementary: a real LID resolves to a phone and has no LID of its own, a
  // phone resolves to a LID and has no phone. Measured on a live account across four
  // chats, every one answered on exactly one side. Where neither answers the address is
  // left alone, since an unknown mapping is not evidence that this one is wrong.
  private async historyJid(jid: string): Promise<string> {
    if (!jid.endsWith("@lid")) return jid;

    try {
      const mapping = this.safeSocket().signalRepository.lidMapping;
      if (await mapping.getPNForLID(jid)) return jid;

      const digits = jid.slice(0, -"@lid".length);
      return (await mapping.getLIDForPN(`${digits}@s.whatsapp.net`)) ?? jid;
    } catch (error) {
      logger.warn(
        "[%s] [historyJid] Failed to resolve %s: %s",
        this.phoneNumber,
        jid,
        errorToString(error),
      );
      return jid;
    }
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

  // Reconnects are fire-and-forget by design -- handleConnectionUpdate must not
  // block on a handshake -- but connect() rejects when it cannot build a socket
  // at all (Redis down inside useRedisAuthState, makeWASocket throwing). An
  // unhandled rejection is fatal in Bun, so one failed reconnect would take the
  // whole worker down and every other connection with it. Aborting rather than
  // only logging because a connection left registered with no socket is the dark
  // phone this change exists to eliminate: abort preserves the auth state and
  // fires onConnectionClose, so the handler evicts us and the number becomes
  // claimable again.
  private reconnectInBackground() {
    void this.connect().catch((error) => {
      logger.error(
        "[%s] [reconnect] could not rebuild socket: %s",
        this.phoneNumber,
        errorToString(error),
      );
      if (!this.isDiscarded) {
        this.abort();
      }
      // abort() gets us out of the handler's registry, but the lease is the
      // coordinator's and the claim scan skips any phone that still has one.
      // Same route a failed restart spawn takes, for the same reason.
      this.onUnrecoverable?.();
    });
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
          this.reconnectInBackground();
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

        this.reconnectInBackground();
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

    // Deliberately NOT re-derived from data.connection here. The two rewrites
    // above describe what the CLIENT is told, not what the socket is doing:
    // `isOnline` is a presence echo on the socket we already have, emitted by
    // sendPresenceUpdate("available") -- which POST /connections calls whenever
    // it reuses a live connection, i.e. every five minutes from the Chatwoot
    // health check. Taking it as connectivity makes a socket still finishing its
    // handshake report `connected: true` on /health, and makes isOpen true, which
    // is the gate that decides whether a run of send timeouts is an ordinary
    // reconnect outage or a send stall. The real field was already applied at the
    // top of this method, before any of the early returns.

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
    // Taken before anything can suspend, so it records the order WhatsApp
    // handed us the events rather than the order they finished being processed.
    const seq = ++this.eventSeq;
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

    // Same two steps as a history dump, and deliberately the same code: repair
    // what this batch can repair itself, file the secrets a later edit will
    // need, and let anything left over go out as an ordinary update.
    // Opened before the secrets are read and closed once they are filed, so an
    // edit arriving on another callback waits for them instead of missing.
    const releaseIntake = this.beginSecretIntake();
    const { kept, unresolved, secrets } = this.repairSecretMessageEdits(
      messagesData.messages,
      { seq },
    );
    // Enqueued here, before the first await: the queue orders edits by the
    // moment they are put on it, and everything below can suspend. Two upsert
    // callbacks run concurrently -- Baileys does not await ours -- so an older
    // edit sitting behind a slow secret write would otherwise reach the queue
    // after a newer one that arrived later, and the older text would win.
    //
    // Nothing is lost by going first: these are the edits whose original is NOT
    // in this batch, so this batch is not what the consumer is missing, and an
    // original it has not written yet answers 404 and is retried.
    this.emitUnresolvedEdits(unresolved);

    // Reserved here, synchronously, and held until the batch is out. Between
    // this line and the send sit a Redis write and a media download, and both
    // can stall: a handoff or SIGTERM landing on either reads inFlightWebhooks
    // as zero, leaves this connection out of drainingWebhooks and exits on top
    // of messages that were never delivered.
    this._inFlightWebhooks += 1;
    try {
      try {
        await this.fileMessageSecrets(secrets);
      } finally {
        releaseIntake();
      }

      if (kept.length > 0) {
        if (kept.length !== messagesData.messages.length) {
          messagesData = { ...messagesData, messages: kept };
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

        await this.sendToWebhook(payload);
      }
    } finally {
      this._inFlightWebhooks -= 1;
    }
  }

  // Sends the edits this batch could not apply itself.
  //
  // Nothing here waits on the upserts: an edit whose original the consumer has
  // not written yet is answered 404 and `awaitResponse` puts the delivery back
  // through the retry loop, so that ordering is already in the protocol. The
  // barriers and delivery slots built to duplicate it only added ways to lose a
  // message the retry never had, and are gone.
  //
  // What the protocol does NOT give is order between two edits of the SAME
  // message: once the target exists both are answered 200, so a first edit
  // working through a retry can land after a second and the older text wins.
  // Hence the chains — one per message, and only per message. A single chain
  // for the connection would have one edit's retry ladder, minutes long,
  // holding back every other chat's edits for an ordering none of them need.
  private emitUnresolvedEdits(unresolved: UnresolvedEdit[]) {
    if (unresolved.length === 0) {
      return;
    }

    // Read while the socket is certainly still there: the deliveries below run
    // on a later tick, and a handoff clears the socket in between. A connection
    // whose first edit targets a message an EARLIER connection filed has never
    // called ownJids yet, so without this the cache would be empty exactly when
    // the socket is gone, and a fromMe edit would derive no candidate at all.
    this.ownJids();

    // Reserved synchronously, for the reason `stallReportChain` reserves its
    // own: nothing reaches sendToWebhook until a microtask, and a SIGTERM
    // landing in that gap would read nothing pending and exit on top of these
    // edits.
    this._inFlightWebhooks += 1;
    const deliveries = unresolved.map(({ message, edit, position }) =>
      this.enqueueEditDelivery(edit.targetKey.id as string, () =>
        this.emitSecretMessageEdit(message, edit, position),
      ),
    );
    Promise.all(deliveries)
      .catch(() => {})
      .finally(() => {
        this._inFlightWebhooks -= 1;
      });
  }

  /**
   * Runs `work` after whatever is already queued for the same message.
   *
   * Two edits of one message have to be delivered in order; two edits of
   * different messages have nothing to do with each other. The chains are
   * therefore per target, and each removes itself once it drains, so nothing
   * has to cap or evict them.
   */
  private enqueueEditDelivery(
    targetId: string,
    work: () => Promise<void>,
  ): Promise<void> {
    const previous = this.editDeliveries.get(targetId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(work)
      .catch(() => {});
    this.editDeliveries.set(targetId, next);
    next.finally(() => {
      // Only if nothing queued behind us in the meantime; that chain is now the
      // one to wait on.
      if (this.editDeliveries.get(targetId) === next) {
        this.editDeliveries.delete(targetId);
      }
    });
    return next;
  }

  /**
   * Opens a window that stays open until this batch's secrets are filed, and
   * returns the handle that closes it. Registered synchronously, so it is
   * already open before anything else on this connection gets to run.
   *
   * An edit's key lookup waits for whatever windows were open when it ran. A
   * miss there is final in a way nothing else in this path is: an edit
   * delivered out of order is answered 404 and the retry loop recovers it, but
   * an edit that found no key emits nothing, so there is nothing to retry. The
   * dump that carries the key can easily still be inside `addressHistory` when
   * the live edit arrives, because Baileys does not await our handlers.
   */
  private beginSecretIntake(): () => void {
    let close: () => void = () => {};
    const open = new Promise<void>((resolve) => {
      close = resolve;
    });
    // Flattened to void, not left as the Promise.all result: the aggregate
    // resolves to an array holding the PREVIOUS aggregate's value, so a
    // long-lived connection would nest one array per event handled and keep
    // every one of them alive. Nothing ever reads the value.
    this.secretIntake = Promise.all([this.secretIntake, open]).then(() => {});
    return close;
  }

  // How many edited messages the ordering guard remembers. An entry is one id
  // and one number, and it only has to outlive the window in which two edits of
  // the same message can still be in flight against each other.
  private static readonly EDIT_POSITION_MEMORY = 1_000;

  /**
   * Whether this edit is the newest one seen for its target, recording it if so.
   *
   * Order of arrival is not something this connection can guarantee. Baileys
   * runs the callbacks concurrently, a dump spends a keystore round trip on
   * addressing before it knows what it holds, and a delivery that had to be
   * retried lands after one that did not. Every attempt to force the order has
   * cost more than it bought, so the guard is on the outcome instead: an edit
   * older than one already applied changes nothing, whichever way it got here.
   *
   * Ordered by the edit's timestamp and then by the event it arrived on, which
   * is what separates two edits stamped in the same second. Without the second
   * term the guard would have to let both through and trust the delivery order,
   * and the delivery order is precisely what a dump's addressing lookup
   * reshuffles.
   */
  private claimEditPosition(targetId: string, position: EditPosition): boolean {
    if (this.editSuperseded(targetId, position)) {
      return false;
    }

    // Re-inserted rather than updated in place, so the map's own order stays
    // least-recently-claimed first and the eviction below takes the right one.
    this.editedAt.delete(targetId);
    this.editedAt.set(targetId, position);
    // Trimmed back to the cap rather than by one entry per claim: a protected
    // candidate is skipped, not evicted, so "evict one" can evict none, and the
    // map would then stay above the cap for as long as the connection lives —
    // every later claim adding one and removing one. The loop runs at most once
    // over the map, and only while it is over the cap.
    for (const candidate of this.editedAt.keys()) {
      if (this.editedAt.size <= BaileysConnection.EDIT_POSITION_MEMORY) {
        break;
      }
      // A message still being delivered keeps its position no matter how old
      // the claim is: the retry consults it before every attempt, and a
      // position that was evicted reads as "nothing applied yet", which is
      // precisely the answer that lets a stale retry through. A history sync
      // touching thousands of messages would otherwise do this routinely.
      //
      // With more deliveries in flight than the cap there is nothing to take,
      // and the map grows until they settle. That is the honest outcome: the
      // alternative is dropping a position something is still consulting. The
      // next claim after they settle brings it back down.
      if (this.editDeliveries.has(candidate)) {
        continue;
      }
      this.editedAt.delete(candidate);
    }
    return true;
  }

  /**
   * Whether something newer than this edit has already been applied.
   *
   * Read again between a delivery's retries, not only before it starts: an edit
   * answered 404 sits in the retry ladder for a minute, and a batch that
   * repaired the same message in the meantime has already sent the newer text.
   * The retry would then land last and put the older text back.
   */
  private editSuperseded(targetId: string, position: EditPosition): boolean {
    const applied = this.editedAt.get(targetId);
    if (!applied) {
      return false;
    }
    if (position.at !== applied.at) {
      return position.at < applied.at;
    }
    if (position.seq !== applied.seq) {
      return position.seq < applied.seq;
    }
    return position.rank < applied.rank;
  }

  private repairSecretMessageEdits(
    messages: WAMessage[],
    { history = false, seq }: { history?: boolean; seq: number },
  ): {
    kept: WAMessage[];
    unresolved: Array<UnresolvedEdit>;
    secrets: MessageSecretEntry[];
  } {
    const { kept, edits } = this.splitSecretMessageEdits(messages);

    // Read BEFORE any repair below, and filed from here rather than from the
    // messages afterwards: applying an edit in place replaces the content that
    // holds the secret, so re-reading a repaired message finds nothing and the
    // NEXT edit to it would arrive undecryptable.
    //
    // `all` and `fresh` differ only for an archive. Filing a secret whose
    // message can no longer be edited is waste, but an archive can carry an
    // original AND its edit in the same batch, and that edit is decryptable
    // right here from a secret nothing would ever store. Age decides what is
    // worth keeping, never what this batch can read.
    const { all, fresh } = this.collectMessageSecrets(kept);
    const secrets = history ? fresh : all;

    if (edits.length === 0) {
      return { kept, unresolved: [], secrets };
    }

    const unresolved: UnresolvedEdit[] = [];

    // Indexed from this batch, not from Redis: an edit arriving alongside its
    // original needs that original's secret, and a round trip per edit would
    // ask the network for something already in hand.
    const byId = new Map<string, WAMessage>();
    const secretById = new Map<string, Uint8Array>();
    for (const entry of all) {
      secretById.set(entry.messageId, entry.secret);
    }
    for (const message of kept) {
      const id = message.key?.id;
      if (id) {
        byId.set(id, message);
      }
    }

    // Ranked by the order they were just sorted into, which is the order they
    // are applied in.
    const ordered = orderEditsOldestFirst(edits, { newestFirst: history });
    for (const [rank, { message, edit }] of ordered.entries()) {
      const targetId = edit.targetKey.id as string;
      const target = byId.get(targetId);
      const secret = secretById.get(targetId);
      const position = { at: messageTimestampSeconds(message), seq, rank };
      if (!target || !secret) {
        unresolved.push({ message, edit, position });
        continue;
      }

      try {
        const decrypted = decryptMessageEdit({
          encPayload: edit.encPayload,
          encIv: edit.encIv,
          origMsgId: targetId,
          messageSecret: secret,
          senderCandidates: messageEditSenderCandidates({
            editKey: message.key,
            targetKey: edit.targetKey,
            me: this.ownJids(),
            storedSenders: messageAuthorJids(target.key, this.ownJids()),
          }),
        });
        if (!decrypted) {
          // Not a dead end: the batch knows only how this copy addressed the
          // author, and the store may hold a form an earlier copy carried (see
          // the merge in rememberMessageSecret). Hand it to the unresolved path,
          // which asks the store and tries those too.
          logger.warn(
            "[%s] [repairSecretMessageEdits] no in-batch candidate decrypted, deferring targetId=%s",
            this.phoneNumber,
            targetId,
          );
          unresolved.push({ message, edit, position });
          continue;
        }
        if (!this.claimEditPosition(targetId, position)) {
          continue;
        }
        target.message = replaceInnerContent(
          target.message,
          decodeEditedMessage(decrypted.plaintext),
        );
      } catch (error) {
        logger.warn(
          "[%s] [repairSecretMessageEdits] failed targetId=%s\n%s",
          this.phoneNumber,
          targetId,
          errorToString(error),
        );
      }
    }

    return { kept, unresolved, secrets };
  }

  // Files only the messages a future edit could still target. WhatsApp closes
  // the edit window minutes after sending, and a secret outlives its usefulness
  // by MESSAGE_SECRET_TTL_SECONDS, so anything older than that can never
  // decrypt anything: filing an archive's worth of them would spend a round
  // trip per message, hold the dump behind all of them, and leave a keyspace
  // nothing will ever read.
  // The secrets on these messages, as store entries. Split from the write so
  // the read can happen before an in-place repair overwrites what it reads.
  private collectMessageSecrets(messages: WAMessage[]): {
    all: MessageSecretEntry[];
    fresh: MessageSecretEntry[];
  } {
    const oldest = Date.now() / 1000 - MESSAGE_SECRET_TTL_SECONDS;
    const all: MessageSecretEntry[] = [];
    const fresh: MessageSecretEntry[] = [];

    for (const message of messages) {
      const messageId = message.key?.id;
      const secret = messageId ? ownMessageSecret(message) : null;
      if (!messageId || !secret) {
        continue;
      }
      const entry: MessageSecretEntry = {
        messageId,
        secret,
        senders: messageAuthorJids(message.key, this.ownJids()),
      };
      all.push(entry);
      // A live message is current by definition, so only a dump ever splits
      // here: an archive reaches back past any replay window, and filing those
      // secrets leaves a keyspace nothing will read.
      if (messageTimestampSeconds(message) >= oldest) {
        fresh.push(entry);
      }
    }

    return { all, fresh };
  }

  private async fileMessageSecrets(entries: MessageSecretEntry[]) {
    if (entries.length === 0) {
      return;
    }

    try {
      await withTimeout(
        "rememberMessageSecrets",
        config.baileys.messageSecretStoreTimeoutMs,
        () => rememberMessageSecrets(this.phoneNumber, entries),
      );
    } catch (error) {
      // A secret we cannot file is a future edit we cannot decrypt, never a
      // reason to withhold the messages themselves.
      logger.warn(
        "[%s] [fileMessageSecrets] failed for %d message(s)\n%s",
        this.phoneNumber,
        entries.length,
        errorToString(error),
      );
    }
  }

  private splitSecretMessageEdits(messages: WAMessage[]): {
    kept: WAMessage[];
    edits: Array<{ message: WAMessage; edit: SecretMessageEdit }>;
  } {
    const kept: WAMessage[] = [];
    const edits: Array<{ message: WAMessage; edit: SecretMessageEdit }> = [];

    for (const message of messages) {
      const edit = secretMessageEdit(message);
      if (edit) {
        edits.push({ message, edit });
      } else {
        kept.push(message);
      }
    }

    return { kept, edits };
  }

  private async emitSecretMessageEdit(
    message: WAMessage,
    edit: SecretMessageEdit,
    position: EditPosition,
  ) {
    try {
      await this.decryptAndEmitMessageEdit(message, edit, position);
    } catch (error) {
      // Contained per edit. Redis can refuse the lookup and a decrypted payload
      // can still fail to parse, and neither is a reason to lose the other
      // edits in the batch — nor, before this was awaited after the upsert, the
      // ordinary messages that rode in with them.
      logger.warn(
        "[%s] [emitSecretMessageEdit] failed targetId=%s\n%s",
        this.phoneNumber,
        edit.targetKey.id,
        errorToString(error),
      );
    }
  }

  private async decryptAndEmitMessageEdit(
    message: WAMessage,
    { targetKey, encPayload, encIv }: SecretMessageEdit,
    position: EditPosition,
  ) {
    const targetId = targetKey.id as string;

    // The dump or upsert carrying this message's secret may still be filing it.
    // Bounded, because `addressHistory` waits on the keystore and a wedged one
    // must not park every edit behind it: on a timeout the lookup goes ahead
    // and, at worst, misses the way it would have anyway.
    try {
      await withTimeout(
        "secretIntake",
        config.baileys.messageSecretStoreTimeoutMs,
        () => this.secretIntake,
      );
    } catch (error) {
      logger.warn(
        "[%s] [emitSecretMessageEdit] secret intake did not settle targetId=%s\n%s",
        this.phoneNumber,
        targetId,
        errorToString(error),
      );
    }

    const stored = await withTimeout(
      "recallMessageSecret",
      config.baileys.messageSecretStoreTimeoutMs,
      () => recallMessageSecret(this.phoneNumber, targetId),
    );
    if (!stored) {
      // The original never passed through this instance, or it did so more than
      // MESSAGE_SECRET_TTL_SECONDS ago. Nothing to derive the key from.
      logger.warn(
        "[%s] [emitSecretMessageEdit] no stored secret for targetId=%s",
        this.phoneNumber,
        targetId,
      );
      return;
    }

    const decrypted = decryptMessageEdit({
      encPayload,
      encIv,
      origMsgId: targetId,
      messageSecret: stored.secret,
      senderCandidates: messageEditSenderCandidates({
        editKey: message.key,
        targetKey,
        me: this.ownJids(),
        storedSenders: stored.senders,
      }),
    });

    if (!decrypted) {
      logger.warn(
        "[%s] [emitSecretMessageEdit] no sender candidate decrypted targetId=%s",
        this.phoneNumber,
        targetId,
      );
      return;
    }

    logger.debug(
      "[%s] [emitSecretMessageEdit] decrypted targetId=%s senders=%o",
      this.phoneNumber,
      targetId,
      decrypted.senders,
    );

    // Claimed only now, for the same reason the in-batch path claims after
    // decrypting: an edit that cannot be read changes nothing, and letting it
    // take the position would reject a later, older edit that CAN be read as
    // superseded by an update nobody ever received.
    if (!this.claimEditPosition(targetId, position)) {
      logger.debug(
        "[%s] [emitSecretMessageEdit] superseded targetId=%s",
        this.phoneNumber,
        targetId,
      );
      return;
    }

    // Same shape Baileys emits for a plaintext MESSAGE_EDIT: the edit's own key
    // with the id swapped for the original's, so the consumer updates the
    // message that was edited rather than creating a new one.
    await this.handleMessagesUpdate(
      [
        {
          key: { ...message.key, id: targetId },
          update: {
            message: {
              editedMessage: {
                message: decodeEditedMessage(decrypted.plaintext),
              },
            },
            messageTimestamp: message.messageTimestamp,
          },
        },
      ],
      // Re-checked between retries: a 404 puts this delivery in the retry ladder
      // for a minute, and a batch that repaired the same message meanwhile has
      // already sent the newer text. Without this, the retry lands last and puts
      // the older text back. It cannot cover a request already on the wire; that
      // last sliver is the consumer's to settle, and is what #393 is about.
      { stillWanted: () => !this.editSuperseded(targetId, position) },
    );
  }

  // Remembered rather than read fresh every time, because a handoff clears the
  // socket while its webhooks are deliberately left draining. An edit still in
  // that queue with `fromMe` derives its key from the account's own JIDs, and
  // reading them off a socket that is already gone yields no candidate at all
  // and drops the edit without a word.
  private ownJidsSeen: OwnJids = {};

  private ownJids(): OwnJids {
    const user = this.socket?.user;
    // Merged one field at a time: `lid` can be absent from a user record that
    // still has `id`, and overwriting wholesale would throw away the form the
    // derivation actually used.
    if (user?.id) {
      this.ownJidsSeen.id = user.id;
    }
    if (user?.lid) {
      this.ownJidsSeen.lid = user.lid;
    }
    return { ...this.ownJidsSeen };
  }

  /**
   * The event listener, as opposed to the relay the encrypted path calls.
   *
   * Baileys still turns a plaintext MESSAGE_EDIT into exactly the shape the
   * encrypted path synthesises: the original message's id, an `editedMessage`
   * body, and the edit's own timestamp. Both edit the same message, so both
   * have to answer to the same guard. Without this, an encrypted edit sitting
   * in the retry ladder would never learn that a newer plaintext edit had
   * already landed, and would put its older text back — and a plaintext edit
   * older than an encrypted one already applied would do the same in reverse.
   *
   * Only the listener claims. The encrypted path claims before it calls the
   * relay, and hands `stillWanted` that very position to compare against;
   * claiming again on the way through would supersede it and make the delivery
   * abandon itself one attempt later.
   */
  private onMessagesUpdate(
    data: BaileysEventMap["messages.update"],
  ): Promise<unknown> {
    const seq = ++this.eventSeq;
    const edits: {
      entry: BaileysEventMap["messages.update"][number];
      targetId: string;
      position: EditPosition;
    }[] = [];
    const rest: BaileysEventMap["messages.update"] = [];

    data.forEach((entry, rank) => {
      const targetId = entry.key?.id;
      if (!entry.update?.message?.editedMessage || !targetId) {
        rest.push(entry);
        return;
      }
      const position = { at: messageTimestampSeconds(entry.update), seq, rank };
      if (!this.claimEditPosition(targetId, position)) {
        // Relaying it would put the older text back over the newer one, which
        // is the whole point of the claim.
        logger.debug(
          "[%s] [onMessagesUpdate] superseded plaintext edit targetId=%s",
          this.phoneNumber,
          targetId,
        );
        return;
      }
      edits.push({ entry, targetId, position });
    });

    if (edits.length) {
      // One delivery per edit, on the target's own chain, exactly as the
      // encrypted path does — and for the same three reasons. A batch relayed
      // whole could only carry one `stillWanted` for all of it, so one aged
      // edit would drop the others; the chain keeps two edits of one message in
      // order without holding up any other chat; and being IN `editDeliveries`
      // is what stops a history sync from evicting this position out from under
      // its own retry.
      //
      // Reserved synchronously, for the reason `emitUnresolvedEdits` reserves
      // its own: nothing reaches sendToWebhook until a microtask, and a SIGTERM
      // landing in that gap would read nothing pending and exit on top of it.
      this._inFlightWebhooks += 1;
      const deliveries = edits.map(({ entry, targetId, position }) =>
        this.enqueueEditDelivery(targetId, () =>
          this.handleMessagesUpdate([entry], {
            // Re-read between retries, not only before the first attempt: a
            // 404 parks this in the retry ladder for a minute, and an
            // encrypted edit applied meanwhile has already sent newer text.
            stillWanted: () => !this.editSuperseded(targetId, position),
          }).then(() => {}),
        ),
      );
      Promise.all(deliveries)
        .catch(() => {})
        .finally(() => {
          this._inFlightWebhooks -= 1;
        });
    }

    if (!rest.length) {
      // Nothing left to relay inline, but this was still inbound activity and
      // the rebalancer reads silence as idle. The deliveries above mark it too,
      // a tick later, which is a tick too late.
      this.markTraffic();
      return Promise.resolve();
    }

    return this.handleMessagesUpdate(rest);
  }

  private handleMessagesUpdate(
    data: BaileysEventMap["messages.update"],
    options?: { stillWanted?: () => boolean },
  ): Promise<unknown> {
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

    // Returned, not fired and forgotten: the encrypted-edit chain advances on
    // this promise, and a chain that advanced on the CALL would let a second
    // edit start while the first was still working through its retries — the
    // older text then landing last and winning.
    return this.sendToWebhook(
      {
        event: "messages.update",
        data,
      },
      {
        awaitResponse: true,
        stillWanted: options?.stillWanted,
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
    // Evidence first, ownership second, and the order is load-bearing:
    // isOurSubmittedKey has a side effect. It parks an id it does not recognise
    // so a send that had not yet learned its generated id can claim it
    // retroactively -- and that claim is read as an acknowledgement. Running it
    // ahead of the status check parks ids from updates that are not
    // acknowledgements at all (an ERROR status, or an edit carrying none), and
    // /health then reports end-to-end delivery for a message WhatsApp rejected.
    const acked = data.some(
      ({ key, update }) =>
        update?.status !== undefined &&
        update.status !== null &&
        update.status >= WAMessageStatus.SERVER_ACK &&
        this.isOurSubmittedKey(key),
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
    // Same ordering as trackOutgoingAck, and for the same reason: a receipt with
    // no timestamp on it is not an acknowledgement, and must not park an id that
    // a later send would then claim as one.
    const acked = data.some(
      ({ key, receipt }) =>
        (receipt?.receiptTimestamp != null ||
          receipt?.readTimestamp != null ||
          receipt?.playedTimestamp != null) &&
        this.isOurSubmittedKey(key),
    );
    if (acked) {
      this._lastOutgoingAckAt = Date.now();
    }
  }

  private isOurSubmittedKey(key: WAMessageKey | undefined | null): boolean {
    if (key?.fromMe !== true || key.id === undefined || key.id === null) {
      return false;
    }
    if (this.submittedMessageIds.has(key.id)) {
      return true;
    }
    // Not ours yet, and it may never be: `fromMe` also covers messages the
    // operator sent from the phone itself, which must not count as proof that
    // OUR send path works. But when the caller reserved no messageId we only
    // learn the generated one once socket.sendMessage resolves, and WhatsApp can
    // acknowledge before that -- the node is on the wire while the enclosing
    // keystore transaction is still committing. Held here so trackSubmittedId
    // can claim it retroactively; if it never does, it decays with the socket.
    this.rememberUnmatchedAck(key.id);
    return false;
  }

  private rememberUnmatchedAck(messageId: string) {
    if (this.unmatchedAckIds.size >= UNMATCHED_ACK_HISTORY) {
      const oldest = this.unmatchedAckIds.keys().next().value;
      if (oldest !== undefined) {
        this.unmatchedAckIds.delete(oldest);
      }
    }
    this.unmatchedAckIds.set(messageId, Date.now());
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

  // WhatsApp's history: the dump the phone sends on pairing, and -- the reason
  // this is forwarded regardless of `syncFullHistory` -- the offline replay of
  // whatever arrived while the connection was down. `syncFullHistory` decides
  // what the socket ASKS the phone for; it does not decide whether what the
  // phone volunteers is worth delivering. Dropping it is how messages received
  // during a disconnect used to disappear.
  //
  // Sent as frames rather than one body. A whole dump is megabytes once the
  // protobuf `bytes` fields are JSON-encoded, and serializing it in one go
  // freezes the process for every session on it, not just this one. The
  // classification (`syncType`) rides along so the client can tell an offline
  // replay from an archive it may not be allowed to store.
  //
  // NOTE: the dump carries no media bytes regardless of the `includeMedia`
  // option, and downloading them here has never worked, so a historical
  // message's media resolves through /media and is stored unsupported when the
  // file was never fetched.
  private async handleMessagingHistorySet(
    data: BaileysEventMap["messaging-history.set"],
  ) {
    // Read here, before the addressing round trip below: two dumps whose edits
    // are stamped in the same second are separated only by the order they
    // arrived in, and after the await that order is gone.
    const seq = ++this.eventSeq;

    // Opened before the addressing round trip below, which is the window the
    // whole gate exists for: a live edit arriving while this dump is still
    // resolving LIDs would look its key up, find the dump had not filed it yet
    // and drop the edit with nothing to retry.
    const releaseIntake = this.beginSecretIntake();

    // Same reservation, same reason as the live path: the Redis write below is
    // a stall this connection has to survive being drained through, and until
    // the first frame reaches sendToWebhook nothing else is holding it.
    this._inFlightWebhooks += 1;
    try {
      let messages: WAMessage[] = [];
      try {
        // Addressing first, secrets second, and the order is load-bearing: a
        // dump's keys arrive without their `remoteJidAlt`/`participantAlt`, and
        // those are the second JID form every stored author candidate needs.
        // Filing before the restore would record half the candidates, and a
        // later edit derived from the form we dropped would never verify.
        const addressed = await this.addressHistory(
          data.messages ?? [],
          data.lidPnMappings,
          data.chats ?? [],
        );
        const { kept, unresolved, secrets } = this.repairSecretMessageEdits(
          addressed,
          { history: true, seq },
        );
        messages = kept;
        // Same reason as the live path: enqueued before the write below, so the
        // queue's order is the order the dumps were handled in rather than
        // whichever one finished writing first.
        this.emitUnresolvedEdits(unresolved);
        await this.fileMessageSecrets(secrets);
      } finally {
        // Closed as soon as the secrets are down, not after the frames: an edit
        // has no reason to wait behind the delivery of a whole archive.
        releaseIntake();
      }

      await this.deliverHistoryFrames(data, messages);
    } finally {
      this._inFlightWebhooks -= 1;
    }
  }

  private async deliverHistoryFrames(
    data: BaileysEventMap["messaging-history.set"],
    messages: WAMessage[],
  ) {
    // The one thing worth keeping from the chat records: which chats have
    // nothing older left. An answer that still has history behind it carries no
    // chat record at all, so an empty list here means "no news", never "there
    // is more".
    const exhausted = exhaustedChats(data.chats ?? []);
    // The other thing worth keeping from the chat records: what the groups in this dump
    // are called. Without it every imported group lands under its own jid.
    const names = groupNames(data.chats ?? []);
    const namedGroups = Object.keys(names).length;
    if (messages.length === 0 && exhausted.length === 0) {
      return;
    }

    logger.info(
      "[%s] [handleMessagingHistorySet] syncType=%s messages=%d isLatest=%s progress=%s exhausted=%d groupNames=%d",
      this.phoneNumber,
      data.syncType ?? "-",
      messages.length,
      data.isLatest ?? "-",
      data.progress ?? "-",
      exhausted.length,
      namedGroups,
    );

    let chunkIndex = 0;
    for (const frame of historyFrames(
      messages,
      config.webhook.historyFrameMaxBytes,
      names,
    )) {
      const framedNames = frame.groupNames;
      const payload: BaileysHistoryFramePayload = {
        messages: frame.messages,
        syncType: data.syncType,
        progress: data.progress,
        isLatest: data.isLatest,
        chunkIndex,
        ...(chunkIndex === 0 && exhausted.length > 0 ? { exhausted } : {}),
        // Per frame, unlike `exhausted`, and scoped to the frame's own chats. The frames
        // are cut by byte budget and not by chat, so a group's messages can land in the
        // fourth one alone and a map sent once would name whichever groups happened to
        // open the dump. Sending the whole map on each one instead would put a payload on
        // every frame that grows with the account.
        ...(Object.keys(framedNames).length > 0
          ? { groupNames: framedNames }
          : {}),
      };
      chunkIndex += 1;
      await this.sendToWebhook({
        event: "messaging-history.set",
        data: payload,
      });
    }

    // A chat with nothing left answers with an anchor and a flag, but nothing
    // promises it answers with a message at all, and `historyFrames` yields
    // nothing for an empty list. The flag is the whole point of that answer, so
    // it goes out on its own rather than being lost with the empty slice.
    if (chunkIndex === 0) {
      await this.sendToWebhook({
        event: "messaging-history.set",
        data: {
          messages: [],
          syncType: data.syncType,
          progress: data.progress,
          isLatest: data.isLatest,
          chunkIndex: 0,
          exhausted,
        },
      });
    }
  }

  // Restores the addressing a dump strips (see historySync.ts), from the two
  // places the LID→PN mapping lives: the event, which speaks about the chats in
  // this dump, and the mapping store, which also knows the group authors and
  // whatever earlier traffic taught it. The store is asked only about the LIDs
  // the event left unnamed, and in one batched read for the whole dump.
  //
  // Both of the event's own copies are read -- the derived list and the chat
  // records it was derived from -- because the buffered path drops the first and
  // the second is all a real history notification arrives with. See
  // `chatLidPnPairs`.
  //
  // A store that cannot be read costs the phone numbers it would have supplied,
  // not the dump: what the event carried still applies, and every LID-addressed
  // key is still marked as one, which is what keeps a client from reading the
  // address as a phone number.
  private async addressHistory(
    messages: WAMessage[],
    mappings: LIDMapping[] | undefined,
    chats: Chat[],
  ) {
    const index = lidPnIndex(mappings, chatLidPnPairs(chats));
    const missing = unresolvedLids(messages, index);

    if (missing.length > 0) {
      try {
        const stored =
          await this.safeSocket().signalRepository.lidMapping.getPNsForLIDs(
            missing,
          );
        for (const [lid, pn] of lidPnIndex(stored)) {
          index.set(lid, pn);
        }
      } catch (error) {
        logger.warn(
          "[%s] [addressHistory] Failed to resolve LID mappings: %s",
          this.phoneNumber,
          errorToString(error),
        );
      }
    }

    return restoreAddressing(messages, index);
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
      stillWanted?: () => boolean;
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
      /**
       * Asked again before every attempt. Answering false abandons the delivery,
       * for a payload that has been made obsolete while it was being retried.
       * Absent means "always wanted", which is every other caller.
       */
      stillWanted?: () => boolean;
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
      if (options?.stillWanted && !options.stillWanted()) {
        logger.info(
          "[%s] [sendToWebhook] [ABANDONED] event=%s attempt=%d",
          this.phoneNumber,
          payload.event,
          attempt,
        );
        return;
      }

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
        // Without a deadline a webhook that accepts the connection and then
        // never answers parks this delivery forever, and a graceful shutdown
        // waits on it (see _inFlightWebhooks). Timing out feeds the retry loop,
        // which is the behaviour every other failure already gets.
        signal: AbortSignal.timeout(config.webhook.timeoutMs),
      });
      return { response };
    } catch (error) {
      return { error: error as Error };
    }
  }
}
