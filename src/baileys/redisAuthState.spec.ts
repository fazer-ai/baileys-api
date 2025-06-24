import { describe, it, mock } from "bun:test";

mock.module("@/lib/redis", () => ({
  redis: mock(() => ({
    keys: () => new Promise((resolve) => resolve([])),
    hSet: (..._args: [string, string, string]) =>
      new Promise((resolve) => resolve(true)),
    hGet: (..._args: [string, string]) =>
      new Promise((resolve) => resolve(null)),
    del: (..._args: [string]) => new Promise((resolve) => resolve(true)),
    multi: mock(() => ({
      hSet: (..._args: [string, string, string]) =>
        new Promise((resolve) => resolve(true)),
      hDel: (..._args: [string, string]) =>
        new Promise((resolve) => resolve(true)),
      execAsPipeline: () => new Promise((resolve) => resolve([])),
    })),
  })),
}));

describe("redisAuthState", () => {
  const testId = "test-session";
  const redisKeyPrefix = "@baileys-api:connections";
  const _authStateKey = `${redisKeyPrefix}:${testId}:authState`;

  describe("#useRedisAuthState", () => {
    it.todo("initialize credentials when none exist in Redis");
    it.todo("save provided metadata when creating a new state");
    it.todo("load existing credentials from Redis");
    it.todo("overwrite metadata when loading an existing state");

    describe("state.keys", () => {
      describe("get", () => {
        it.todo("retrieve and return existing signal keys");
        it.todo("correctly handle the 'app-state-sync-key' type");
        it.todo("return an empty object if keys do not exist");
      });
      describe("set", () => {
        it.todo("save new key data to Redis");
        it.todo("update existing key data");
        it.todo("remove keys when the value is null or undefined");
      });
      describe("clear", () => {
        it.todo("remove the entire authState hash from Redis");
      });
    });

    describe("saveCreds", () => {
      it.todo("write the updated credentials object to Redis");
    });

    describe("error handling", () => {
      it.todo("throw an error if Redis connection fails during read");
      it.todo("throw an error if data in Redis is corrupted (invalid JSON)");
    });
  });

  describe("#getRedisSavedAuthStateIds", () => {
    it.todo("return a list of IDs and metadata for all saved states");
    it.todo("return an empty array if no states are saved");
    it.todo("return metadata as an empty object if not set in Redis");
    it.todo("handle corrupted metadata (invalid JSON) in one of the records");
  });
});
