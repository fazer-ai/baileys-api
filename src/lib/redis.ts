import { createClient } from "redis";
import config from "@/config";
import { errorToString } from "@/helpers/errorToString";
import logger from "@/lib/logger";

const redis = createClient(config.redis);

redis.on("error", (error) => {
  logger.error("Redis client error\n%s", errorToString(error));
});

redis.on("connect", async () => {
  await redis.clientSetName("baileys-api");
  logger.info("Connected to Redis");
});

export async function initializeRedis() {
  if (!redis.isOpen) {
    await redis.connect();
  }

  return redis;
}

// A client in subscribe mode cannot run regular commands, so pub/sub
// consumers (the proxy's route-cache invalidation) need their own connection.
export function createSubscriberClient() {
  return redis.duplicate();
}

export default redis;
