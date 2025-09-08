import {
  type AuthenticationCreds,
  type AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStoreWithTransaction,
  type TransactionCapabilityOptions,
} from "@whiskeysockets/baileys";
import redis from "@/lib/redis";

const redisKeyPrefix = "@baileys-api:connections";

// NOTE: Inspired by https://github.com/hbinduni/baileys-redis-auth
export async function useRedisAuthState(
  id: string,
  metadata?: unknown,
  transactionOptions: TransactionCapabilityOptions = {
    maxCommitRetries: 3,
    delayBetweenTriesMs: 200,
  },
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

  // Transaction state management
  let transactionsInProgress = 0;
  let transactionCache: { [type: string]: { [id: string]: unknown } } = {};
  let mutations: { [type: string]: { [id: string]: unknown } } = {};

  // Helper function to check if we are currently in a transaction
  const isInTransaction = () => transactionsInProgress > 0;

  // Helper function to commit transaction
  const commitTransaction = async (): Promise<void> => {
    if (!Object.keys(mutations).length) {
      return;
    }

    let retries = transactionOptions.maxCommitRetries;
    while (retries > 0) {
      retries -= 1;
      try {
        // Convert mutations to the format expected by the set method
        const multi = redis.multi();
        for (const category in mutations) {
          for (const id in mutations[category]) {
            const field = `${category}-${id}`;
            const value = mutations[category][id];
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
        return;
      } catch (error) {
        if (retries > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, transactionOptions.delayBetweenTriesMs),
          );
        } else {
          throw error;
        }
      }
    }
  };

  // Helper function to clean up transaction state
  const cleanupTransactionState = (): void => {
    transactionsInProgress -= 1;
    if (transactionsInProgress === 0) {
      transactionCache = {};
      mutations = {};
    }
  };

  // Create the enhanced keys object with transaction support
  const keys: SignalKeyStoreWithTransaction = {
    get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
      if (isInTransaction()) {
        const data: { [_: string]: SignalDataTypeMap[T] } = {};
        const cached = transactionCache[type] || {};
        const idsRequiringFetch = ids.filter((id) => !(id in cached));

        // Fetch missing data from Redis
        if (idsRequiringFetch.length > 0) {
          await Promise.all(
            idsRequiringFetch.map(async (id) => {
              const value = await readData("authState", `${type}-${id}`);
              const processedValue =
                type === "app-state-sync-key" && value
                  ? proto.Message.AppStateSyncKeyData.fromObject(value)
                  : value;

              // Update transaction cache
              if (!transactionCache[type]) {
                transactionCache[type] = {};
              }
              transactionCache[type][id] = processedValue;
            }),
          );
        }

        // Return requested data from cache
        for (const id of ids) {
          const value = transactionCache[type]?.[id];
          if (value) {
            data[id] = value as SignalDataTypeMap[T];
          }
        }

        return data;
      }

      // Not in transaction - use original logic
      const data: { [_: string]: SignalDataTypeMap[T] } = {};
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
    set: async (data: SignalDataSet) => {
      if (isInTransaction()) {
        // In transaction - cache mutations
        for (const category in data) {
          if (!transactionCache[category]) {
            transactionCache[category] = {};
          }
          if (!mutations[category]) {
            mutations[category] = {};
          }

          const categoryData = data[category as keyof SignalDataSet];
          if (categoryData && typeof categoryData === "object") {
            for (const id in categoryData) {
              const value = (categoryData as Record<string, unknown>)[id];
              transactionCache[category][id] = value;
              mutations[category][id] = value;
            }
          }
        }
        return;
      }

      // Not in transaction - use original logic
      type DataKey = keyof typeof data;
      const multi = redis.multi();
      for (const category in data) {
        const categoryData = data[category as DataKey];
        if (categoryData && typeof categoryData === "object") {
          for (const id in categoryData) {
            const field = `${category}-${id}`;
            const value = (categoryData as Record<string, unknown>)[id];
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
      }
      await multi.execAsPipeline();
    },
    clear: async () => {
      if (isInTransaction()) {
        // In transaction - mark all keys for deletion
        const keys = await redis.keys(`${createKey("authState")}*`);
        for (const key of keys) {
          const field = key.split(":").pop();
          if (field && field !== "creds" && field !== "metadata") {
            const parts = field.split("-");
            if (parts.length >= 2) {
              const type = parts[0];
              const id = parts.slice(1).join("-");
              if (!mutations[type]) {
                mutations[type] = {};
              }
              mutations[type][id] = null; // null indicates deletion
            }
          }
        }
        // Clear transaction cache as well
        transactionCache = {};
        return;
      }

      // Not in transaction - use original logic
      await redis.del(createKey("authState"));
    },
    isInTransaction,
    transaction: async <T>(
      work: () => Promise<T>,
      _key = "default",
    ): Promise<T> => {
      transactionsInProgress += 1;

      try {
        const result = await work();

        // Commit if this is the outermost transaction
        if (transactionsInProgress === 1) {
          await commitTransaction();
        }

        return result;
      } finally {
        cleanupTransactionState();
      }
    },
  };

  return {
    state: {
      creds,
      keys,
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
