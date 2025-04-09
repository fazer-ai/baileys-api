import packageInfo from "@/../package.json";
import type { LevelWithSilentOrString } from "pino";

const {
  NODE_ENV,
  PORT,
  LOG_LEVEL,
  BAILEYS_LOG_LEVEL,
  BAILEYS_PRINT_QR,
  REDIS_URL,
  REDIS_PASSWORD,
  WEBHOOK_RETRY_POLICY_MAX_RETRIES,
  WEBHOOK_RETRY_POLICY_RETRY_INTERVAL,
  WEBHOOK_RETRY_POLICY_BACKOFF_FACTOR,
} = process.env;

const config = {
  packageInfo: { name: packageInfo.name, version: packageInfo.version },
  port: PORT ? Number(PORT) : 3025,
  env: (NODE_ENV || "development") as "development" | "production",
  logLevel: (LOG_LEVEL || "info") as LevelWithSilentOrString,
  baileys: {
    logLevel: (BAILEYS_LOG_LEVEL || "warn") as LevelWithSilentOrString,
    printQr: BAILEYS_PRINT_QR === "true",
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
};

// biome-ignore lint/style/noDefaultExport: <explanation>
export default config;
