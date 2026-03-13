import { beforeEach, describe, expect, it } from "bun:test";
import { initAuthCreds } from "@whiskeysockets/baileys";
import redis from "@/lib/redis";
import { getRedisSavedAuthStateIds, useRedisAuthState } from "./redisAuthState";

// Access mock internals through the shared preload mock
const mockRedisData = (redis as any).__hashData as Map<
  string,
  Map<string, string>
>;
const mockMultiCommands = (redis as any).__multiCommands as Array<{
  op: string;
  args: any[];
}>;

describe("useRedisAuthState", () => {
  beforeEach(() => {
    mockRedisData.clear();
    mockMultiCommands.length = 0;
    (redis.hSet as any).mockClear();
    (redis.hGet as any).mockClear();
    (redis.del as any).mockClear();
    (redis.keys as any).mockClear();
    (redis.multi as any).mockClear();
    (initAuthCreds as any).mockClear();
  });

  it("initializes new credentials when none exist in Redis", async () => {
    const { state } = await useRedisAuthState("test-phone");
    expect(initAuthCreds).toHaveBeenCalledTimes(1);
    expect(state.creds).toBeDefined();
    expect(state.creds.registrationId).toBe(12345);
  });

  it("loads existing credentials from Redis", async () => {
    const existingCreds = { registrationId: 99999, noiseKey: "existing" };
    const key = "@baileys-api:connections:existing-phone:authState";
    mockRedisData.set(key, new Map());
    mockRedisData.get(key)?.set("creds", JSON.stringify(existingCreds));

    const { state } = await useRedisAuthState("existing-phone");
    expect(initAuthCreds).not.toHaveBeenCalled();
    expect(state.creds.registrationId).toBe(99999);
  });

  it("stores metadata when creating state", async () => {
    const metadata = { webhookUrl: "https://example.com", clientName: "Test" };
    await useRedisAuthState("meta-phone", metadata);

    const key = "@baileys-api:connections:meta-phone:authState";
    const stored = mockRedisData.get(key)?.get("metadata");
    expect(stored).toBe(JSON.stringify(metadata));
  });

  describe("state.keys.get", () => {
    it("retrieves existing signal keys", async () => {
      const key = "@baileys-api:connections:keys-phone:authState";
      mockRedisData.set(key, new Map());
      mockRedisData
        .get(key)
        ?.set("pre-key-1", JSON.stringify({ keyId: 1, publicKey: "pub1" }));

      const { state } = await useRedisAuthState("keys-phone");
      const result = await state.keys.get("pre-key", ["1"]);
      expect(result["1"]).toEqual({ keyId: 1, publicKey: "pub1" } as never);
    });

    it("handles app-state-sync-key type with fromObject", async () => {
      const key = "@baileys-api:connections:sync-phone:authState";
      mockRedisData.set(key, new Map());
      mockRedisData
        .get(key)
        ?.set(
          "app-state-sync-key-abc",
          JSON.stringify({ fingerprint: "fp", keyData: "data" }),
        );

      const { state } = await useRedisAuthState("sync-phone");
      const result = await state.keys.get("app-state-sync-key", ["abc"]);
      expect(result.abc).toHaveProperty("__appStateSyncKey", true);
    });

    it("returns null for non-existent keys", async () => {
      const { state } = await useRedisAuthState("empty-phone");
      const result = await state.keys.get("pre-key", ["nonexistent"]);
      expect(result.nonexistent).toBeNull();
    });
  });

  describe("state.keys.set", () => {
    it("saves key data to Redis via multi pipeline", async () => {
      const { state } = await useRedisAuthState("set-phone");
      await state.keys.set({
        "pre-key": {
          "1": { keyId: 1, publicKey: "pub1" } as never,
        },
      });

      const key = "@baileys-api:connections:set-phone:authState";
      const stored = mockRedisData.get(key)?.get("pre-key-1");
      expect(stored).toBeDefined();
      expect(JSON.parse(stored!)).toEqual({ keyId: 1, publicKey: "pub1" });
    });

    it("removes keys when value is null", async () => {
      const key = "@baileys-api:connections:del-phone:authState";
      mockRedisData.set(key, new Map());
      mockRedisData.get(key)?.set("pre-key-1", "some-data");

      const { state } = await useRedisAuthState("del-phone");
      await state.keys.set({
        "pre-key": {
          "1": null as any,
        },
      });

      expect(mockRedisData.get(key)?.has("pre-key-1")).toBe(false);
    });
  });

  describe("state.keys.clear", () => {
    it("removes the entire authState hash from Redis", async () => {
      const key = "@baileys-api:connections:clear-phone:authState";
      mockRedisData.set(
        key,
        new Map([["creds", JSON.stringify({ registrationId: 1 })]]),
      );

      const { state } = await useRedisAuthState("clear-phone");
      await state.keys.clear?.();

      expect(mockRedisData.has(key)).toBe(false);
    });
  });

  describe("saveCreds", () => {
    it("writes updated credentials to Redis", async () => {
      const { state, saveCreds } = await useRedisAuthState("save-phone");

      // Mutate creds (as baileys does)
      (state.creds as any).registrationId = 54321;
      await saveCreds();

      const key = "@baileys-api:connections:save-phone:authState";
      const stored = mockRedisData.get(key)?.get("creds");
      expect(stored).toBeDefined();
      expect(JSON.parse(stored!).registrationId).toBe(54321);
    });
  });
});

describe("getRedisSavedAuthStateIds", () => {
  beforeEach(() => {
    mockRedisData.clear();
    mockMultiCommands.length = 0;
  });

  it("returns empty array when no states exist", async () => {
    (redis.keys as any).mockResolvedValueOnce([]);
    const result = await getRedisSavedAuthStateIds();
    expect(result).toEqual([]);
  });

  it("returns IDs and metadata for saved states", async () => {
    const key1 = "@baileys-api:connections:+5511999:authState";
    const key2 = "@baileys-api:connections:+5521888:authState";
    mockRedisData.set(
      key1,
      new Map([["metadata", JSON.stringify({ webhookUrl: "url1" })]]),
    );
    mockRedisData.set(
      key2,
      new Map([["metadata", JSON.stringify({ webhookUrl: "url2" })]]),
    );

    const result = (
      await getRedisSavedAuthStateIds<{ webhookUrl: string }>()
    ).sort((a, b) => a.id.localeCompare(b.id));
    expect(result.length).toBe(2);
    expect(result[0].id).toBe("+5511999");
    expect(result[0].metadata.webhookUrl).toBe("url1");
    expect(result[1].id).toBe("+5521888");
    expect(result[1].metadata.webhookUrl).toBe("url2");
  });

  it("filters out entries with null metadata", async () => {
    const key = "@baileys-api:connections:+5511000:authState";
    mockRedisData.set(key, new Map()); // no metadata field

    const result = await getRedisSavedAuthStateIds();
    expect(result).toEqual([]);
  });
});
