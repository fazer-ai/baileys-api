import app from "@/app";
import coordinator from "@/cluster";
import config from "@/config";
import { errorToString } from "@/helpers/errorToString";
import logger, { deepSanitizeObject } from "@/lib/logger";
import { initializeRedis } from "@/lib/redis";
import proxyApp from "@/proxy/app";
import {
  startRouteCacheInvalidation,
  stopRouteCacheInvalidation,
} from "@/proxy/routeCache";
import { MediaCleanupService } from "@/services/mediaCleanup";

const isProxy = config.cluster.role === "proxy";
// Module scope so the shutdown handler can close the listener and drain
// in-flight requests instead of exiting under them.
const server = isProxy ? proxyApp : app;

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

const bootstrap = async () => {
  // Redis must be up before the HTTP listener opens — a worker serving
  // requests without coordination guarantees would hold sockets it can never
  // lease, and the proxy cannot resolve routes at all. Fail fast instead.
  try {
    await initializeRedis();
    if (isProxy) {
      // The proxy holds no sockets and no media; it only needs Redis (route
      // resolution) and the pub/sub invalidation feed. A failed subscription
      // is not fatal — routes still expire via the cache TTL.
      await startRouteCacheInvalidation().catch((error) => {
        logger.error(
          "Failed to start route cache invalidation: %s",
          errorToString(error),
        );
      });
    } else {
      coordinator.start();
    }
  } catch (error) {
    logger.error("Redis initialization failed: %s", errorToString(error));
    process.exit(1);
  }

  server.listen(config.port, () => {
    logger.info(
      `${config.packageInfo.name}@${config.packageInfo.version} (${config.cluster.role}) running on ${server.server?.hostname}:${server.server?.port}`,
    );
    logger.info(
      "Loaded config %s",
      JSON.stringify(
        deepSanitizeObject(config, { omitKeys: ["password"] }),
        null,
        2,
      ),
    );

    if (!isProxy && config.media.cleanupEnabled) {
      mediaCleanup.start();
    }
  });
};

void bootstrap();

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info(`Received ${signal}, shutting down gracefully...`);
  if (isProxy) {
    // Stateless (no leases to hand off), but a forward in flight may already
    // have committed a mutation on a worker — close the listener and let
    // pending requests finish instead of dropping their responses.
    const drainStop = setTimeout(() => {
      logger.error("Proxy drain timed out, exiting");
      process.exit(0);
    }, config.cluster.shutdownTimeoutMs);
    drainStop.unref();
    await server.stop().catch(() => {});
    await stopRouteCacheInvalidation().catch(() => {});
    process.exit(0);
  }
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
