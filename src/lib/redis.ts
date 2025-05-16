import config from "@/config";
import { errorToString } from "@/helpers/errorToString";
import logger from "@/lib/logger";
import { createClient } from "redis";

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

// biome-ignore lint/style/noDefaultExport: <explanation>
export default redis;
