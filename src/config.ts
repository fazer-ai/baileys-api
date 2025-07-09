import type { LevelWithSilentOrString } from "pino";
import packageInfo from "@/../package.json";

const {
  NODE_ENV,
  PORT,
  LOG_LEVEL,
  BAILEYS_LOG_LEVEL,
  REDIS_URL,
  REDIS_PASSWORD,
  WEBHOOK_RETRY_POLICY_MAX_RETRIES,
  WEBHOOK_RETRY_POLICY_RETRY_INTERVAL,
  WEBHOOK_RETRY_POLICY_BACKOFF_FACTOR,
  CORS_ORIGIN,
  KEY_STORE_LRU_CACHE_MAX,
  KEY_STORE_LRU_CACHE_TTL,
} = process.env;

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
  keyStore: {
    lruCacheMax: KEY_STORE_LRU_CACHE_MAX
      ? Number(KEY_STORE_LRU_CACHE_MAX) || 100
      : 100,
    lruCacheTtl: KEY_STORE_LRU_CACHE_TTL
      ? Number(KEY_STORE_LRU_CACHE_TTL) || 1000 * 60 * 10
      : 1000 * 60 * 10, // 10 minutes
  },
};

export default config;
