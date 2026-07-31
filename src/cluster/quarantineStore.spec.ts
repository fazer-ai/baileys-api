import { beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import config from "@/config";
import redis from "@/lib/redis";
import { clusterKeys } from "./keys";
import {
  backoffMs,
  clearQuarantine,
  isQuarantined,
  recordStrike,
} from "./quarantineStore";

const stringData = (redis as any).__stringData as Map<string, string>;

const PHONE = "+5511999999999";
const KEY = clusterKeys.quarantine(PHONE);

// config is the shared preload mock — restore even if a test throws, or every
// spec file that runs after this one sees the mutated values.
const withQuarantineConfig = async (
  overrides: Partial<{
    quarantineEnabled: boolean;
    quarantineBaseMs: number;
    quarantineMaxMs: number;
  }>,
  fn: () => Promise<void>,
) => {
  const previous = {
    quarantineEnabled: config.cluster.quarantineEnabled,
    quarantineBaseMs: config.cluster.quarantineBaseMs,
    quarantineMaxMs: config.cluster.quarantineMaxMs,
  };
  Object.assign(config.cluster, overrides);
  try {
    await fn();
  } finally {
    Object.assign(config.cluster, previous);
  }
};

describe("quarantineStore", () => {
  beforeEach(() => {
    stringData.clear();
  });

  describe("backoffMs", () => {
    it("doubles per strike from the base and caps at the max", () => {
      expect(backoffMs(1)).toBe(60_000);
      expect(backoffMs(2)).toBe(120_000);
      expect(backoffMs(3)).toBe(240_000);
      // 60s * 2^6 = 64min > 1h cap.
      expect(backoffMs(7)).toBe(3_600_000);
      // Far past the exponent clamp: still the cap, never Infinity/NaN.
      expect(backoffMs(10_000)).toBe(3_600_000);
    });
  });

  describe("recordStrike", () => {
    it("starts at one strike and doubles the wait on each further strike", async () => {
      setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      try {
        const now = Date.parse("2026-01-01T00:00:00.000Z");

        const first = await recordStrike(PHONE);
        expect(first).toEqual({ strikes: 1, nextRetryAt: now + 60_000 });

        const second = await recordStrike(PHONE);
        expect(second).toEqual({ strikes: 2, nextRetryAt: now + 120_000 });

        const stored = JSON.parse(stringData.get(KEY)!);
        expect(stored.strikes).toBe(2);
      } finally {
        setSystemTime();
      }
    });

    it("restarts the count on a corrupted entry instead of failing the abort path", async () => {
      stringData.set(KEY, "not-json");

      const state = await recordStrike(PHONE);

      expect(state?.strikes).toBe(1);
    });

    it("is a no-op when quarantine is disabled", async () => {
      await withQuarantineConfig({ quarantineEnabled: false }, async () => {
        const state = await recordStrike(PHONE);

        expect(state).toBeNull();
        expect(stringData.has(KEY)).toBe(false);
      });
    });
  });

  describe("isQuarantined", () => {
    it("is false with no entry", async () => {
      expect(await isQuarantined(PHONE)).toBe(false);
    });

    it("is true until nextRetryAt, false afterwards", async () => {
      stringData.set(
        KEY,
        JSON.stringify({ strikes: 1, nextRetryAt: Date.now() + 60_000 }),
      );
      expect(await isQuarantined(PHONE)).toBe(true);

      stringData.set(
        KEY,
        JSON.stringify({ strikes: 1, nextRetryAt: Date.now() - 1 }),
      );
      expect(await isQuarantined(PHONE)).toBe(false);
    });

    it("is false on a corrupted entry", async () => {
      stringData.set(KEY, "not-json");
      expect(await isQuarantined(PHONE)).toBe(false);
    });

    it("is false when quarantine is disabled, even with a live entry", async () => {
      stringData.set(
        KEY,
        JSON.stringify({ strikes: 1, nextRetryAt: Date.now() + 60_000 }),
      );
      await withQuarantineConfig({ quarantineEnabled: false }, async () => {
        expect(await isQuarantined(PHONE)).toBe(false);
      });
    });
  });

  describe("clearQuarantine", () => {
    it("removes the entry", async () => {
      stringData.set(
        KEY,
        JSON.stringify({ strikes: 5, nextRetryAt: Date.now() + 60_000 }),
      );

      await clearQuarantine(PHONE);

      expect(stringData.has(KEY)).toBe(false);
    });
  });
});
