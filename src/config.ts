import type { LevelWithSilentOrString } from "pino";
import packageInfo from "@/../package.json";

const {
  NODE_ENV,
  PORT,
  LOG_LEVEL,
  BAILEYS_LOG_LEVEL,
  BAILEYS_CLIENT_VERSION,
  BAILEYS_OVERRIDE_CLIENT_VERSION,
  REDIS_URL,
  REDIS_PASSWORD,
  WEBHOOK_RETRY_POLICY_MAX_RETRIES,
  WEBHOOK_RETRY_POLICY_RETRY_INTERVAL,
  WEBHOOK_RETRY_POLICY_BACKOFF_FACTOR,
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

export default config;
