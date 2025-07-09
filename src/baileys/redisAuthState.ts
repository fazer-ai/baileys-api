import {
  type AuthenticationCreds,
  type AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import redis from "@/lib/redis";

const redisKeyPrefix = "@baileys-api:connections";

// NOTE: Inspired by https://github.com/hbinduni/baileys-redis-auth
export async function useRedisAuthState(
  id: string,
  metadata?: unknown,
): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  const createKey = (key: string) => `${redisKeyPrefix}:${id}:${key}`;

  const writeData = (key: string, field: string, data: unknown) =>
    redis.hSet(
      createKey(key),
      field,
      JSON.stringify(data, BufferJSON.replacer),
    );

  const readData = async (key: string, field: string) => {
    const data = await redis.hGet(createKey(key), field);
    return data ? JSON.parse(data, BufferJSON.reviver) : null;
  };

  const creds: AuthenticationCreds =
    (await readData("authState", "creds")) || initAuthCreds();

  await redis.hSet(
    createKey("authState"),
    "metadata",
    JSON.stringify(metadata),
  );

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data: { [_: string]: SignalDataTypeMap[typeof type] } = {};
          await Promise.all(
            ids.map(async (id) => {
              const value = await readData("authState", `${type}-${id}`);
              data[id] =
                type === "app-state-sync-key" && value
                  ? proto.Message.AppStateSyncKeyData.fromObject(value)
                  : value;
            }),
          );
          return data;
        },
        set: async (data) => {
          type DataKey = keyof typeof data;
          const multi = redis.multi();
          for (const category in data) {
            for (const id in data[category as DataKey]) {
              const field = `${category}-${id}`;
              const value = data[category as DataKey]?.[id];
              if (value) {
                multi.hSet(
                  createKey("authState"),
                  field,
                  JSON.stringify(value, BufferJSON.replacer),
                );
              } else {
                multi.hDel(createKey("authState"), field);
              }
            }
          }
          await multi.execAsPipeline();
        },
        clear: async () => {
          await redis.del(createKey("authState"));
        },
      },
    },
    saveCreds: async () => {
      await writeData("authState", "creds", creds);
    },
  };
}

export async function getRedisSavedAuthStateIds<T>(): Promise<
  Array<{ id: string; metadata: T }>
> {
  const keys = await redis.keys(`${redisKeyPrefix}:*:authState`);
  const ids = keys.map((key) => key.split(":").at(-2) ?? "").filter(Boolean);

  const multi = redis.multi();
  for (const id of ids) {
    multi.hGet(`${redisKeyPrefix}:${id}:authState`, "metadata");
  }
  const metadata = await multi.execAsPipeline();
  return ids
    .map((id, i) => ({
      id,
      metadata: metadata[i] ? JSON.parse(metadata[i].toString()) : null,
    }))
    .filter((item) => item.metadata);
}
