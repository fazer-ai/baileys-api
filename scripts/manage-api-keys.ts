import crypto from "crypto";
import redis, { initializeRedis } from "@/lib/redis";
import { REDIS_KEY_PREFIX } from "@/middlewares/auth";

async function createApiKey(role: "user" | "admin", key?: string) {
  const apiKey = key || crypto.randomBytes(24).toString("hex");
  const authData = { role };

  const redisKey = `${REDIS_KEY_PREFIX}:${apiKey}`;
  await redis.set(redisKey, JSON.stringify(authData));

  console.log(`Created API key with role '${role}': ${apiKey}`);
  console.log(apiKey);
  return apiKey;
}

async function deleteApiKey(apiKey: string) {
  const redisKey = `${REDIS_KEY_PREFIX}:${apiKey}`;
  const deleted = await redis.del(redisKey);

  if (deleted) {
    console.log(`API key deleted: ${apiKey}`);
  } else {
    console.log(`API key not found: ${apiKey}`);
  }
}

async function listApiKeys() {
  const keys = await redis.keys(`${REDIS_KEY_PREFIX}:*`);

  if (!keys.length) {
    console.log("No API keys found.");
    return;
  }

  console.log(`Found ${keys.length} API keys\n`);
  for (const key of keys) {
    const apiKey = key.substring(REDIS_KEY_PREFIX.length + 1);
    const authData = await redis.get(key);
    console.log(`- ${apiKey}: ${authData}`);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "create":
      await createApiKey((args[0] as "user" | "admin") || "user", args[1]);
      break;
    case "delete":
      if (args[0]) {
        await deleteApiKey(args[0]);
      }
      break;
    case "list":
      await listApiKeys();
      break;
    default:
      console.log("Usage:");
      console.log(
        `  create [role] [key]  - Create a new API key (role: user|admin)`,
      );
      console.log(`  delete [key]         - Delete an existing API key`);
      console.log(`  list                 - List all existing API keys`);
  }

  await redis.quit();
}

initializeRedis().then(() => main().catch(console.error));
