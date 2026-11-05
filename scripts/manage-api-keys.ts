import {
  API_KEYS_USAGE,
  parseApiKeysCommand,
  runApiKeysCommand,
} from "@/lib/apiKeys";
import redis, { initializeRedis } from "@/lib/redis";

async function main() {
  const command = parseApiKeysCommand(process.argv.slice(2));
  if (!command) {
    for (const line of API_KEYS_USAGE) {
      console.log(line);
    }
    return;
  }

  await initializeRedis();
  try {
    await runApiKeysCommand(command);
  } finally {
    await redis.quit();
  }
}

main().catch(console.error);
