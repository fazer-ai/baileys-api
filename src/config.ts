import type { LevelWithSilentOrString } from "pino";
import packageInfo from "@/../package.json";

const {
  NODE_ENV,
  PORT,
  LOG_LEVEL,
  BAILEYS_LOG_LEVEL,
  BAILEYS_HTTP_TIMEOUT_MS,
  BAILEYS_TX_ACQUIRE_TIMEOUT_MS,
  BAILEYS_TX_HOLD_WARN_MS,
  BAILEYS_SEND_TIMEOUT_MS,
  BAILEYS_SEND_STALL_RESTART_ENABLED,
  BAILEYS_CLIENT_VERSION,
  BAILEYS_OVERRIDE_CLIENT_VERSION,
  REDIS_URL,
  REDIS_PASSWORD,
  WEBHOOK_RETRY_POLICY_MAX_RETRIES,
  WEBHOOK_RETRY_POLICY_RETRY_INTERVAL,
  WEBHOOK_RETRY_POLICY_BACKOFF_FACTOR,
  WEBHOOK_TIMEOUT_MS,
  WEBHOOK_HISTORY_FRAME_MAX_BYTES,
  CORS_ORIGIN,
  IGNORE_GROUP_MESSAGES,
  IGNORE_STATUS_MESSAGES,
  IGNORE_BROADCAST_MESSAGES,
  IGNORE_NEWSLETTER_MESSAGES,
  IGNORE_BOT_MESSAGES,
  IGNORE_META_AI_MESSAGES,
  MEDIA_CLEANUP_ENABLED,
  MEDIA_CLEANUP_INTERVAL_MS,
  MEDIA_MAX_AGE_HOURS,
  BAILEYS_LISTEN_TO_EVENTS,
  ROLE,
  INSTANCE_ID,
  WORKER_BASE_URL,
  CLUSTER_LEASE_TTL_MS,
  CLUSTER_LEASE_RENEW_INTERVAL_MS,
  CLUSTER_CLAIM_INTERVAL_MS,
  CLUSTER_CLAIM_JITTER_MS,
  CLUSTER_RECONNECT_CONCURRENCY,
  CLUSTER_UNCLAIMED_GRACE_MS,
  CLUSTER_RELEASE_COOLDOWN_MS,
  CLUSTER_REBALANCE_ENABLED,
  CLUSTER_REBALANCE_RELEASE_INTERVAL_MS,
  CLUSTER_REBALANCE_TOLERANCE,
  CLUSTER_REBALANCE_IDLE_THRESHOLD_MS,
  CLUSTER_HEARTBEAT_INTERVAL_MS,
  CLUSTER_INSTANCE_TTL_MS,
  CLUSTER_SHUTDOWN_TIMEOUT_MS,
  CLUSTER_QUARANTINE_ENABLED,
  CLUSTER_QUARANTINE_BASE_MS,
  CLUSTER_QUARANTINE_MAX_MS,
  PROXY_ROUTE_CACHE_TTL_MS,
  PROXY_REQUEST_TIMEOUT_MS,
  PROXY_MAX_BODY_BYTES,
} = process.env;

// `Number(raw) || fallback` would collapse an explicit 0 into the fallback
// and silently accept negatives; timing/TTL envs need strict validation.
function intFromEnv(
  name: string,
  raw: string | undefined,
  fallback: number,
  { min = 1 }: { min?: number } = {},
): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return value;
}

function boolFromEnv(
  name: string,
  raw: string | undefined,
  fallback: boolean,
): boolean {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (raw !== "true" && raw !== "false") {
    throw new Error(`${name} must be "true" or "false", got "${raw}"`);
  }
  return raw === "true";
}

// How long the two ffmpeg jobs behind an audio/PTT send may take before we give
// up converting and send the original buffer instead -- the same degradation
// the code already applies when ffmpeg is missing. Not configurable: its only
// job is to make the worker's total wall time bounded and checkable against
// PROXY_REQUEST_TIMEOUT_MS, and an env var would let that check be defeated by
// the same operator it protects.
const AUDIO_PREPROCESS_TIMEOUT_MS = 20_000;

const config = {
  packageInfo: {
    name: packageInfo.name,
    version: packageInfo.version,
    description: packageInfo.description,
    repository: packageInfo.repository,
  },
  port: PORT ? Number(PORT) : 3025,
  env: (NODE_ENV || "development") as "development" | "production",
  logLevel: (LOG_LEVEL || "info") as LevelWithSilentOrString,
  baileys: {
    logLevel: (BAILEYS_LOG_LEVEL || "warn") as LevelWithSilentOrString,
    // Deadline for the lib's own HTTP downloads (patched into getHttpStream).
    // A parked TLS stream there hangs inside the keystore transaction keyed by
    // our own JID and wedges every send on the connection -- the silent send
    // stall. App-state blobs are small, so 120s is pure headroom for the case
    // that matters.
    httpTimeoutMs: intFromEnv(
      "BAILEYS_HTTP_TIMEOUT_MS",
      BAILEYS_HTTP_TIMEOUT_MS,
      120_000,
    ),
    // Reject after waiting this long for the keystore transaction mutex. Six
    // operations share the key `meId`, so one that never returns blocks all of
    // them. Floor is 90s: below `defaultQueryTimeoutMs` (60s) a legitimately
    // slow IQ inside the holder would fail everyone waiting. Defaults to the
    // conservative rollout value -- high enough to be diagnosis-only, since
    // `resyncAppState` is the longest legitimate holder -- so a deploy that
    // sets nothing cannot start failing real transactions. Lower to 90_000
    // once the stall reports name the culprit. 0 disables — and disabling gives up
    // the only bound on how long an abandoned send stays queued on the mutex,
    // which the 24h indeterminate marker in withIdempotency assumes is shorter
    // than a day. Off is a kill switch, not a steady state.
    txAcquireTimeoutMs: intFromEnv(
      "BAILEYS_TX_ACQUIRE_TIMEOUT_MS",
      BAILEYS_TX_ACQUIRE_TIMEOUT_MS,
      300_000,
      { min: 0 },
    ),
    // Report a transaction still holding the mutex after this long. Kept below
    // txAcquireTimeoutMs so the holder's stall report precedes the waiters'
    // timeouts and the logs read in causal order. 0 disables.
    txHoldWarnMs: intFromEnv(
      "BAILEYS_TX_HOLD_WARN_MS",
      BAILEYS_TX_HOLD_WARN_MS,
      30_000,
      { min: 0 },
    ),
    // Deadline on the local ffmpeg work that runs BEFORE the send deadline is
    // armed. Deliberately outside it: ffmpeg is local and slow for honest
    // reasons, so counting it as a send timeout would open the breaker and
    // recreate healthy sockets. But it still spends the request's budget, and
    // the worker's wall time is this plus sendTimeoutMs -- which is what the
    // invariant at the bottom of this file checks against the proxy deadline.
    // Fixed rather than env-driven precisely so that sum stays checkable.
    audioPreprocessTimeoutMs: AUDIO_PREPROCESS_TIMEOUT_MS,
    // Deadline on the socket's own sendMessage. Must stay below
    // PROXY_REQUEST_TIMEOUT_MS, otherwise the proxy cuts first and the worker
    // never gets to release the idempotency lock or count the stall.
    sendTimeoutMs: intFromEnv(
      "BAILEYS_SEND_TIMEOUT_MS",
      BAILEYS_SEND_TIMEOUT_MS,
      45_000,
    ),
    // Whether a connection whose sends keep timing out may recreate its own
    // socket. Off by default: this kills a live socket on a heuristic, so it
    // is opted into after a period of watching the detector fire only on the
    // real pattern. Detection, logging and the webhook run either way.
    sendStallRestartEnabled: boolFromEnv(
      "BAILEYS_SEND_STALL_RESTART_ENABLED",
      BAILEYS_SEND_STALL_RESTART_ENABLED,
      false,
    ),
    clientVersion: BAILEYS_CLIENT_VERSION || "default",
    overrideClientVersion: BAILEYS_OVERRIDE_CLIENT_VERSION === "true",
    // FIXME: We ignore any non-user messages for now. As we implement more features,
    // we can enable them as needed.
    ignoreGroupMessages: IGNORE_GROUP_MESSAGES
      ? IGNORE_GROUP_MESSAGES === "true"
      : false,
    ignoreStatusMessages: IGNORE_STATUS_MESSAGES
      ? IGNORE_STATUS_MESSAGES === "true"
      : true,
    ignoreBroadcastMessages: IGNORE_BROADCAST_MESSAGES
      ? IGNORE_BROADCAST_MESSAGES === "true"
      : true,
    ignoreNewsletterMessages: IGNORE_NEWSLETTER_MESSAGES
      ? IGNORE_NEWSLETTER_MESSAGES === "true"
      : true,
    ignoreBotMessages: IGNORE_BOT_MESSAGES
      ? IGNORE_BOT_MESSAGES === "true"
      : true,
    ignoreMetaAiMessages: IGNORE_META_AI_MESSAGES
      ? IGNORE_META_AI_MESSAGES === "true"
      : true,
    listenToEvents: new Set(
      BAILEYS_LISTEN_TO_EVENTS
        ? BAILEYS_LISTEN_TO_EVENTS.split(",").map((e) => e.trim())
        : [],
    ),
  },
  redis: {
    url: REDIS_URL || "redis://localhost:6379",
    password: REDIS_PASSWORD || "",
  },
  webhook: {
    // Deadline for a single webhook delivery. A webhook that accepts the
    // connection and never answers would otherwise park the delivery -- and the
    // graceful shutdown that waits on it -- indefinitely.
    timeoutMs: intFromEnv("WEBHOOK_TIMEOUT_MS", WEBHOOK_TIMEOUT_MS, 60_000),
    // Serialized size a single `messaging-history.set` frame may reach before
    // the dump is split. Bun is single-threaded: one JSON.stringify of a whole
    // history freezes every session on the instance, and the retry loop then
    // resends that same body up to three more times.
    historyFrameMaxBytes: intFromEnv(
      "WEBHOOK_HISTORY_FRAME_MAX_BYTES",
      WEBHOOK_HISTORY_FRAME_MAX_BYTES,
      512 * 1024,
      { min: 1024 },
    ),
    retryPolicy: {
      maxRetries: WEBHOOK_RETRY_POLICY_MAX_RETRIES
        ? Number(WEBHOOK_RETRY_POLICY_MAX_RETRIES)
        : 3,
      retryInterval: WEBHOOK_RETRY_POLICY_RETRY_INTERVAL
        ? Number(WEBHOOK_RETRY_POLICY_RETRY_INTERVAL)
        : 5000,
      backoffFactor: WEBHOOK_RETRY_POLICY_BACKOFF_FACTOR
        ? Number(WEBHOOK_RETRY_POLICY_BACKOFF_FACTOR)
        : 3,
    },
  },
  corsOrigin: CORS_ORIGIN || "localhost",
  cluster: {
    role: (ROLE || "standalone") as "standalone" | "worker" | "proxy",
    instanceId: INSTANCE_ID || undefined,
    workerBaseUrl: WORKER_BASE_URL || undefined,
    leaseTtlMs: intFromEnv(
      "CLUSTER_LEASE_TTL_MS",
      CLUSTER_LEASE_TTL_MS,
      30_000,
    ),
    leaseRenewIntervalMs: intFromEnv(
      "CLUSTER_LEASE_RENEW_INTERVAL_MS",
      CLUSTER_LEASE_RENEW_INTERVAL_MS,
      10_000,
    ),
    claimIntervalMs: intFromEnv(
      "CLUSTER_CLAIM_INTERVAL_MS",
      CLUSTER_CLAIM_INTERVAL_MS,
      5_000,
    ),
    claimJitterMs: intFromEnv(
      "CLUSTER_CLAIM_JITTER_MS",
      CLUSTER_CLAIM_JITTER_MS,
      2_000,
      { min: 0 },
    ),
    reconnectConcurrency: intFromEnv(
      "CLUSTER_RECONNECT_CONCURRENCY",
      CLUSTER_RECONNECT_CONCURRENCY,
      5,
    ),
    unclaimedGraceMs: intFromEnv(
      "CLUSTER_UNCLAIMED_GRACE_MS",
      CLUSTER_UNCLAIMED_GRACE_MS,
      30_000,
      { min: 0 },
    ),
    releaseCooldownMs: intFromEnv(
      "CLUSTER_RELEASE_COOLDOWN_MS",
      CLUSTER_RELEASE_COOLDOWN_MS,
      60_000,
      { min: 0 },
    ),
    rebalanceEnabled: boolFromEnv(
      "CLUSTER_REBALANCE_ENABLED",
      CLUSTER_REBALANCE_ENABLED,
      true,
    ),
    rebalanceReleaseIntervalMs: intFromEnv(
      "CLUSTER_REBALANCE_RELEASE_INTERVAL_MS",
      CLUSTER_REBALANCE_RELEASE_INTERVAL_MS,
      10_000,
    ),
    rebalanceTolerance: intFromEnv(
      "CLUSTER_REBALANCE_TOLERANCE",
      CLUSTER_REBALANCE_TOLERANCE,
      1,
      { min: 0 },
    ),
    // 0 disables the timing component of idle detection: every connection
    // without in-flight webhooks counts as idle (useful in tests, surprising
    // in production).
    rebalanceIdleThresholdMs: intFromEnv(
      "CLUSTER_REBALANCE_IDLE_THRESHOLD_MS",
      CLUSTER_REBALANCE_IDLE_THRESHOLD_MS,
      300_000,
      { min: 0 },
    ),
    heartbeatIntervalMs: intFromEnv(
      "CLUSTER_HEARTBEAT_INTERVAL_MS",
      CLUSTER_HEARTBEAT_INTERVAL_MS,
      5_000,
    ),
    instanceTtlMs: intFromEnv(
      "CLUSTER_INSTANCE_TTL_MS",
      CLUSTER_INSTANCE_TTL_MS,
      15_000,
    ),
    shutdownTimeoutMs: intFromEnv(
      "CLUSTER_SHUTDOWN_TIMEOUT_MS",
      CLUSTER_SHUTDOWN_TIMEOUT_MS,
      30_000,
      { min: 0 },
    ),
    // Backoff for phones whose reconnect cycles keep failing (see
    // cluster/quarantineStore.ts): first failed cycle waits quarantineBaseMs
    // before background claims retry, doubling per failed cycle up to
    // quarantineMaxMs.
    quarantineEnabled: boolFromEnv(
      "CLUSTER_QUARANTINE_ENABLED",
      CLUSTER_QUARANTINE_ENABLED,
      true,
    ),
    quarantineBaseMs: intFromEnv(
      "CLUSTER_QUARANTINE_BASE_MS",
      CLUSTER_QUARANTINE_BASE_MS,
      60_000,
    ),
    quarantineMaxMs: intFromEnv(
      "CLUSTER_QUARANTINE_MAX_MS",
      CLUSTER_QUARANTINE_MAX_MS,
      3_600_000,
    ),
  },
  proxy: {
    routeCacheTtlMs: intFromEnv(
      "PROXY_ROUTE_CACHE_TTL_MS",
      PROXY_ROUTE_CACHE_TTL_MS,
      5_000,
    ),
    // Above the worst-case worker operation: POST /connections (client
    // version fetch + socket handshake) and send-message with audio
    // preprocessing.
    requestTimeoutMs: intFromEnv(
      "PROXY_REQUEST_TIMEOUT_MS",
      PROXY_REQUEST_TIMEOUT_MS,
      75_000,
    ),
    // Bodies are buffered for 421/409 replay; the cap keeps a handful of
    // concurrent large uploads from exhausting the proxy's memory. 64 MiB
    // leaves headroom over chatwoot's default 40 MB attachment limit after
    // base64 inflation (~54 MiB).
    maxBodyBytes: intFromEnv(
      "PROXY_MAX_BODY_BYTES",
      PROXY_MAX_BODY_BYTES,
      64 * 1024 * 1024,
    ),
  },
  media: {
    cleanupEnabled: MEDIA_CLEANUP_ENABLED === "true",
    cleanupIntervalMs: Number(MEDIA_CLEANUP_INTERVAL_MS) || 60 * 60 * 1000, // 1 hour
    maxAgeHours: Number(MEDIA_MAX_AGE_HOURS) || 24, // 24 hours
  },
};

if (!["standalone", "worker", "proxy"].includes(config.cluster.role)) {
  throw new Error(
    `Invalid ROLE "${config.cluster.role}" — expected standalone, worker or proxy`,
  );
}
// A renewal must fit comfortably inside the lease TTL (and a heartbeat inside
// the instance TTL), otherwise a single slow round-trip expires the lease and
// causes spurious failovers.
if (config.cluster.leaseRenewIntervalMs > config.cluster.leaseTtlMs / 2) {
  throw new Error(
    "CLUSTER_LEASE_RENEW_INTERVAL_MS must be at most half of CLUSTER_LEASE_TTL_MS",
  );
}
if (config.cluster.heartbeatIntervalMs > config.cluster.instanceTtlMs / 2) {
  throw new Error(
    "CLUSTER_HEARTBEAT_INTERVAL_MS must be at most half of CLUSTER_INSTANCE_TTL_MS",
  );
}
if (config.cluster.quarantineBaseMs > config.cluster.quarantineMaxMs) {
  throw new Error(
    "CLUSTER_QUARANTINE_BASE_MS must be at most CLUSTER_QUARANTINE_MAX_MS",
  );
}
// The floor exists because defaultQueryTimeoutMs is 60s: below that, an IQ the
// holder is legitimately waiting on would fail every waiter behind it. A small
// nonzero value is therefore never a gentler setting, it is a way to break all
// sends, so it is rejected rather than clamped.
if (
  config.baileys.txAcquireTimeoutMs > 0 &&
  config.baileys.txAcquireTimeoutMs < 90_000
) {
  throw new Error(
    "BAILEYS_TX_ACQUIRE_TIMEOUT_MS must be 0 (disabled) or at least 90000",
  );
}
// The holder's stall report has to land before the waiters start timing out,
// otherwise the logs show the symptom with no trace of its cause.
if (
  config.baileys.txAcquireTimeoutMs > 0 &&
  config.baileys.txHoldWarnMs >= config.baileys.txAcquireTimeoutMs
) {
  throw new Error(
    "BAILEYS_TX_HOLD_WARN_MS must be lower than BAILEYS_TX_ACQUIRE_TIMEOUT_MS",
  );
}
// A send that outlives the proxy's deadline is answered by the proxy's generic
// 504, so the worker's own 504/503 -- and the lock release that goes with it --
// never reach the caller. The audio budget is part of the sum because it is
// spent BEFORE the send deadline is armed: for a PTT the worker's wall time is
// both, and comparing the send deadline alone would state a guarantee the
// worker cannot keep.
if (
  config.baileys.sendTimeoutMs + config.baileys.audioPreprocessTimeoutMs >=
  config.proxy.requestTimeoutMs
) {
  throw new Error(
    `BAILEYS_SEND_TIMEOUT_MS plus the ${AUDIO_PREPROCESS_TIMEOUT_MS}ms audio-preprocessing budget must be lower than PROXY_REQUEST_TIMEOUT_MS`,
  );
}

export default config;
