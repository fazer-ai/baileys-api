import { createHash, randomBytes } from "node:crypto";
import logger from "@/lib/logger";
import redis from "@/lib/redis";
import { type AuthData, REDIS_KEY_PREFIX } from "@/middlewares/auth";

// The env var the Coolify template already sets on every deployment (it is the
// same value Chatwoot is given as its default key). Read here rather than in
// config: the whole config object is logged at boot, and this is a credential.
export const DEFAULT_API_KEY_ENV = "BAILEYS_PROVIDER_DEFAULT_API_KEY";

// What logs show in place of a key: the prefix of the same sha256 the auth
// middleware stores as a session's apiKeyHash, so an operator can tell which
// key a line is about without the line being usable as one.
export function apiKeyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 8);
}

const redisKey = (apiKey: string) => `${REDIS_KEY_PREFIX}:${apiKey}`;

// Registers the deployment's default key at boot, so the key reaches the app
// through the environment instead of a command line that the shell, `bun run`
// and `docker inspect` all print. NX on purpose: an operator who promoted this
// key to admin keeps it admin across restarts.
export async function provisionDefaultApiKey(
  apiKey: string | undefined = process.env[DEFAULT_API_KEY_ENV],
): Promise<void> {
  if (!apiKey) {
    return;
  }

  const authData: AuthData = { role: "user" };
  const created = await redis.set(redisKey(apiKey), JSON.stringify(authData), {
    NX: true,
  });

  logger.info(
    created
      ? "Registered default API key %s from %s"
      : "Default API key %s from %s already registered",
    apiKeyFingerprint(apiKey),
    DEFAULT_API_KEY_ENV,
  );
}

export type ApiKeysCommand =
  | { name: "create"; role: AuthData["role"]; key?: string }
  | { name: "delete"; key: string }
  | { name: "list" };

export const API_KEYS_USAGE = [
  "Usage:",
  "  create [role] [key]  - Create an API key (role: user|admin); generates one when no key is given",
  "  delete <key>         - Delete an existing API key",
  "  list                 - List all existing API keys",
];

export function parseApiKeysCommand(args: string[]): ApiKeysCommand | null {
  const [command, ...rest] = args;

  switch (command) {
    case "create":
      return {
        name: "create",
        role: (rest[0] as AuthData["role"]) || "user",
        key: rest[1] || undefined,
      };
    case "delete":
      return rest[0] ? { name: "delete", key: rest[0] } : null;
    case "list":
      return { name: "list" };
    default:
      return null;
  }
}

type Print = (line: string) => void;

export async function runApiKeysCommand(
  command: ApiKeysCommand,
  print: Print = console.log,
): Promise<void> {
  switch (command.name) {
    case "create": {
      const apiKey = command.key ?? randomBytes(24).toString("hex");
      const authData: AuthData = { role: command.role };
      await redis.set(redisKey(apiKey), JSON.stringify(authData));

      // A key the caller supplied is already known to them, and this command
      // runs at boot in older deployments: echoing it puts it in the container
      // log. A generated key has no other way to reach the operator.
      print(
        command.key
          ? `Created API key with role '${command.role}' (${apiKeyFingerprint(apiKey)})`
          : `Created API key with role '${command.role}': ${apiKey}`,
      );
      return;
    }
    case "delete": {
      const deleted = await redis.del(redisKey(command.key));
      const fingerprint = apiKeyFingerprint(command.key);
      print(
        deleted
          ? `API key deleted (${fingerprint})`
          : `API key not found (${fingerprint})`,
      );
      return;
    }
    case "list": {
      const keys = await redis.keys(`${REDIS_KEY_PREFIX}:*`);
      if (!keys.length) {
        print("No API keys found.");
        return;
      }

      print(`Found ${keys.length} API keys\n`);
      for (const key of keys) {
        const apiKey = key.substring(REDIS_KEY_PREFIX.length + 1);
        const authData = await redis.get(key);
        print(`- ${apiKey}: ${authData}`);
      }
      return;
    }
  }
}
