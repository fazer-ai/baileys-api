import { beforeEach, describe, expect, it } from "bun:test";
import { initAuthCreds } from "@whiskeysockets/baileys";
import redis from "@/lib/redis";
import {
  advanceImportCandidate,
  clearImportCandidates,
  getRedisSavedAuthStateIds,
  isRedisAuthStatePaired,
  seedImportedSession,
  useRedisAuthState,
} from "./redisAuthState";

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

  it("rejects metadata writes when the lease is owned by another instance", async () => {
    // A zombie socket auto-reconnecting after losing its lease must not
    // replay stale config (webhookUrl, apiKeyHash) over a newer
    // client-driven update written through the new owner.
    const mockStringData = (redis as any).__stringData as Map<string, string>;
    const key = "@baileys-api:connections:meta-fenced-phone:authState";
    mockRedisData.set(
      key,
      new Map([["metadata", JSON.stringify({ webhookUrl: "current" })]]),
    );
    mockStringData.set(
      "@baileys-api:cluster:lease:meta-fenced-phone",
      JSON.stringify({ owner: "someone-else", epoch: 2 }),
    );

    await useRedisAuthState("meta-fenced-phone", { webhookUrl: "stale" });

    expect(mockRedisData.get(key)?.get("metadata")).toBe(
      JSON.stringify({ webhookUrl: "current" }),
    );
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
    it("saves key data to Redis via the fenced batch write", async () => {
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

      // The mock mirrors real Redis: deleting the last field removes the
      // hash itself, so the field is gone either way.
      expect(mockRedisData.get(key)?.get("pre-key-1")).toBeUndefined();
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

    it("does not clear the hash when the lease is owned by another instance", async () => {
      // A stale instance processing a late loggedOut must not wipe the auth
      // state out from under the live owner.
      const mockStringData = (redis as any).__stringData as Map<string, string>;
      const key = "@baileys-api:connections:stale-clear-phone:authState";
      mockRedisData.set(
        key,
        new Map([["creds", JSON.stringify({ registrationId: 1 })]]),
      );
      mockStringData.set(
        "@baileys-api:cluster:lease:stale-clear-phone",
        JSON.stringify({ owner: "someone-else", epoch: 2 }),
      );

      const { state } = await useRedisAuthState("stale-clear-phone");
      await state.keys.clear?.();

      expect(mockRedisData.has(key)).toBe(true);
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

  describe("owner fencing", () => {
    // The split-brain hazard: a zombie socket writing Signal keys over the
    // new owner's state regresses the ratchet ("Bad MAC"). Writes only land
    // when the lease is ours — or when there is no lease at all, since then
    // there is no competing owner to protect.
    const mockStringData = (redis as any).__stringData as Map<string, string>;

    it("drops writes when the lease is owned by another instance", async () => {
      mockStringData.set(
        "@baileys-api:cluster:lease:fenced-phone",
        JSON.stringify({ owner: "someone-else", epoch: 2 }),
      );

      const { state, saveCreds } = await useRedisAuthState("fenced-phone");
      (state.creds as any).registrationId = 777;
      await saveCreds();
      await state.keys.set({
        "pre-key": { "1": { keyId: 1 } as never },
      });

      const hash = mockRedisData.get(
        "@baileys-api:connections:fenced-phone:authState",
      );
      expect(hash?.get("creds")).toBeUndefined();
      expect(hash?.get("pre-key-1")).toBeUndefined();
    });

    it("lands writes when this instance owns the lease", async () => {
      mockStringData.set(
        "@baileys-api:cluster:lease:owned-phone",
        JSON.stringify({ owner: "test-instance", epoch: 2 }),
      );

      const { saveCreds } = await useRedisAuthState("owned-phone");
      await saveCreds();

      const hash = mockRedisData.get(
        "@baileys-api:connections:owned-phone:authState",
      );
      expect(hash?.get("creds")).toBeDefined();
    });

    it("lands writes when no lease exists", async () => {
      const { saveCreds } = await useRedisAuthState("unleased-phone");
      await saveCreds();

      const hash = mockRedisData.get(
        "@baileys-api:connections:unleased-phone:authState",
      );
      expect(hash?.get("creds")).toBeDefined();
    });
  });
});

describe("seedImportedSession", () => {
  const mockStringData = (redis as any).__stringData as Map<string, string>;
  const candidates = [{ private: "a", public: "b" }];

  it("writes creds + candidate cursor together when no lease exists", async () => {
    const ok = await seedImportedSession(
      "seed-phone",
      initAuthCreds(),
      candidates,
      0,
    );

    expect(ok).toBe(true);
    const hash = mockRedisData.get(
      "@baileys-api:connections:seed-phone:authState",
    );
    expect(hash?.get("creds")).toBeDefined();
    expect(JSON.parse(hash?.get("import-candidates") as string)).toEqual({
      candidates,
      index: 0,
    });
  });

  it("writes when this instance owns the lease", async () => {
    mockStringData.set(
      "@baileys-api:cluster:lease:seed-owned-phone",
      JSON.stringify({ owner: "test-instance", epoch: 1 }),
    );

    const ok = await seedImportedSession(
      "seed-owned-phone",
      initAuthCreds(),
      candidates,
      0,
    );

    expect(ok).toBe(true);
    const hash = mockRedisData.get(
      "@baileys-api:connections:seed-owned-phone:authState",
    );
    expect(hash?.get("creds")).toBeDefined();
    // The candidate cursor is part of the same atomic write, not just creds.
    expect(JSON.parse(hash?.get("import-candidates") as string)).toEqual({
      candidates,
      index: 0,
    });
  });

  it("is fenced off (false, no write) when the lease is owned elsewhere", async () => {
    mockStringData.set(
      "@baileys-api:cluster:lease:seed-fenced-phone",
      JSON.stringify({ owner: "someone-else", epoch: 2 }),
    );

    const ok = await seedImportedSession(
      "seed-fenced-phone",
      initAuthCreds(),
      candidates,
      0,
    );

    expect(ok).toBe(false);
    expect(
      mockRedisData
        .get("@baileys-api:connections:seed-fenced-phone:authState")
        ?.get("creds"),
    ).toBeUndefined();
  });
});

describe("import candidate cycling", () => {
  const authKey = (phone: string) =>
    `@baileys-api:connections:${phone}:authState`;

  const setHash = (phone: string, fields: Record<string, string>) => {
    mockRedisData.set(authKey(phone), new Map(Object.entries(fields)));
  };

  const mockStringData = (redis as any).__stringData as Map<string, string>;
  const setLease = (phone: string, owner: string) => {
    mockStringData.set(
      `@baileys-api:cluster:lease:${phone}`,
      JSON.stringify({ owner, epoch: 1 }),
    );
  };

  it("advanceImportCandidate swaps the noiseKey and bumps the cursor", async () => {
    setHash("adv-phone", {
      creds: JSON.stringify({ noiseKey: { private: "OLD" }, me: { id: "x" } }),
      "import-candidates": JSON.stringify({
        candidates: [
          { private: "p0", public: "q0" },
          { private: "p1", public: "q1" },
        ],
        index: 0,
      }),
    });

    const advanced = await advanceImportCandidate("adv-phone");

    expect(advanced).toBe(true);
    const hash = mockRedisData.get(authKey("adv-phone"))!;
    expect(JSON.parse(hash.get("import-candidates")!).index).toBe(1);
    // The old candidate's noiseKey must have been replaced.
    expect(JSON.parse(hash.get("creds")!).noiseKey.private).not.toBe("OLD");
  });

  it("advanceImportCandidate returns false when the candidates are exhausted", async () => {
    setHash("exhaust-phone", {
      creds: JSON.stringify({ noiseKey: {} }),
      "import-candidates": JSON.stringify({
        candidates: [{ private: "only", public: "only" }],
        index: 0,
      }),
    });

    expect(await advanceImportCandidate("exhaust-phone")).toBe(false);
  });

  it("advanceImportCandidate returns false when nothing was seeded", async () => {
    expect(await advanceImportCandidate("no-import-phone")).toBe(false);
  });

  it("advanceImportCandidate writes when this instance owns the lease", async () => {
    setHash("adv-owned", {
      creds: JSON.stringify({ noiseKey: { private: "OLD" }, me: { id: "x" } }),
      "import-candidates": JSON.stringify({
        candidates: [
          { private: "p0", public: "q0" },
          { private: "p1", public: "q1" },
        ],
        index: 0,
      }),
    });
    setLease("adv-owned", "test-instance");

    expect(await advanceImportCandidate("adv-owned")).toBe(true);
    expect(
      JSON.parse(
        mockRedisData.get(authKey("adv-owned"))!.get("import-candidates")!,
      ).index,
    ).toBe(1);
  });

  it("advanceImportCandidate is fenced off when another instance owns the lease", async () => {
    setHash("adv-fenced", {
      creds: JSON.stringify({ noiseKey: { private: "OLD" }, me: { id: "x" } }),
      "import-candidates": JSON.stringify({
        candidates: [
          { private: "p0", public: "q0" },
          { private: "p1", public: "q1" },
        ],
        index: 0,
      }),
    });
    setLease("adv-fenced", "someone-else");

    expect(await advanceImportCandidate("adv-fenced")).toBe(false);
    // A fenced-off advance moves neither the cursor nor the noiseKey.
    const hash = mockRedisData.get(authKey("adv-fenced"))!;
    expect(JSON.parse(hash.get("import-candidates")!).index).toBe(0);
    expect(JSON.parse(hash.get("creds")!).noiseKey.private).toBe("OLD");
  });

  it("clearImportCandidates removes the cursor", async () => {
    setHash("clear-phone", {
      creds: JSON.stringify({ noiseKey: {} }),
      "import-candidates": JSON.stringify({ candidates: [], index: 0 }),
    });

    await clearImportCandidates("clear-phone");

    expect(
      mockRedisData.get(authKey("clear-phone"))?.get("import-candidates"),
    ).toBeUndefined();
  });

  it("clearImportCandidates is fenced off when another instance owns the lease", async () => {
    setHash("clear-fenced", {
      creds: JSON.stringify({ noiseKey: {} }),
      "import-candidates": JSON.stringify({ candidates: [], index: 0 }),
    });
    setLease("clear-fenced", "someone-else");

    expect(await clearImportCandidates("clear-fenced")).toBe(false);
    // The cursor survives a fenced-off clear.
    expect(
      mockRedisData.get(authKey("clear-fenced"))?.get("import-candidates"),
    ).toBeDefined();
  });
});

describe("isRedisAuthStatePaired", () => {
  beforeEach(() => {
    mockRedisData.clear();
  });

  const setCreds = (id: string, creds: unknown) => {
    mockRedisData.set(
      `@baileys-api:connections:${id}:authState`,
      new Map([["creds", JSON.stringify(creds)]]),
    );
  };

  it("returns true when creds carry a registered identity", async () => {
    setCreds("paired", { me: { id: "5511999@s.whatsapp.net" } });
    expect(await isRedisAuthStatePaired("paired")).toBe(true);
  });

  it("returns false when pairing never completed", async () => {
    setCreds("unpaired", { registrationId: 1 });
    expect(await isRedisAuthStatePaired("unpaired")).toBe(false);
  });

  it("returns false when there are no creds at all", async () => {
    expect(await isRedisAuthStatePaired("missing")).toBe(false);
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
