import app from "@/app";
import coordinator from "@/cluster";
import config from "@/config";
import { errorToString } from "@/helpers/errorToString";
import logger, { deepSanitizeObject } from "@/lib/logger";
import { initializeRedis } from "@/lib/redis";
import { MediaCleanupService } from "@/services/mediaCleanup";

process.on("uncaughtException", (error) => {
  logger.error(
    "[UNCAUGHT EXCEPTION] An uncaught exception occurred: %s",
    errorToString(error),
  );
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error(
    "[UNHANDLED_REJECTION] An unhandled promise rejection occurred at: %o, reason: %s",
    promise,
    errorToString(reason as Error),
  );
});

const mediaCleanup = new MediaCleanupService({
  maxAgeHours: config.media.maxAgeHours,
  intervalMs: config.media.cleanupIntervalMs,
});

app.listen(config.port, () => {
  logger.info(
    `${config.packageInfo.name}@${config.packageInfo.version} running on ${app.server?.hostname}:${app.server?.port}`,
  );
  logger.info(
    "Loaded config %s",
    JSON.stringify(
      deepSanitizeObject(config, { omitKeys: ["password"] }),
      null,
      2,
    ),
  );

  if (config.media.cleanupEnabled) {
    mediaCleanup.start();
  }

  // A node that serves HTTP without Redis (and therefore without coordinator
  // loops) would hold sockets it can never lease — fail fast instead.
  initializeRedis()
    .then(() => coordinator.start())
    .catch((error) => {
      logger.error("Redis initialization failed: %s", errorToString(error));
      process.exit(1);
    });
});

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info(`Received ${signal}, shutting down gracefully...`);
  mediaCleanup.stop();

  // Hard stop in case the handoff wedges (e.g. Redis unreachable mid-drain) —
  // better to exit and let lease TTLs run the failover than to hang past the
  // orchestrator's kill timeout with sockets half-closed.
  const hardStop = setTimeout(() => {
    logger.error("Graceful shutdown timed out, exiting");
    process.exit(0);
  }, config.cluster.shutdownTimeoutMs + 5_000);
  hardStop.unref();

  try {
    await coordinator.shutdown();
  } catch (error) {
    logger.error("Error during shutdown: %s", errorToString(error));
  }
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
