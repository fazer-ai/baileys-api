import { describe, it } from "bun:test";

describe("redisAuthState", () => {
  describe("#useRedisAuthState", () => {
    it.todo("initialize credentials when none exist in Redis", () => {});
    it.todo("save provided metadata when creating a new state", () => {});
    it.todo("load existing credentials from Redis", () => {});
    it.todo("overwrite metadata when loading an existing state", () => {});

    describe("state.keys", () => {
      describe("get", () => {
        it.todo("retrieve and return existing signal keys", () => {});
        it.todo("correctly handle the 'app-state-sync-key' type", () => {});
        it.todo("return an empty object if keys do not exist", () => {});
      });
      describe("set", () => {
        it.todo("save new key data to Redis", () => {});
        it.todo("update existing key data", () => {});
        it.todo("remove keys when the value is null or undefined", () => {});
      });
      describe("clear", () => {
        it.todo("remove the entire authState hash from Redis", () => {});
      });
    });

    describe("saveCreds", () => {
      it.todo("write the updated credentials object to Redis", () => {});
    });

    describe("error handling", () => {
      it.todo("throw an error if Redis connection fails during read", () => {});
      it.todo("throw an error if data in Redis is corrupted (invalid JSON)", () => {});
    });
  });

  describe("#getRedisSavedAuthStateIds", () => {
    it.todo("return a list of IDs and metadata for all saved states", () => {});
    it.todo("return an empty array if no states are saved", () => {});
    it.todo("return metadata as an empty object if not set in Redis", () => {});
    it.todo("handle corrupted metadata (invalid JSON) in one of the records", () => {});
  });
});
