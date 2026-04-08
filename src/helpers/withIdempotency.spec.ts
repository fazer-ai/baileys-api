import { afterEach, describe, expect, it, mock } from "bun:test";
import redis from "@/lib/redis";
import { withIdempotency } from "./withIdempotency";

const stringData = (redis as any).__stringData as Map<string, string>;

describe("withIdempotency", () => {
  afterEach(() => {
    stringData.clear();
  });

  describe("without idempotency key", () => {
    it("executes the function and returns executed status", async () => {
      const fn = mock(async () => ({ id: "msg_1" }));

      const result = await withIdempotency(null, fn);

      expect(result).toEqual({ status: "executed", value: { id: "msg_1" } });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("returns failed status when function returns null", async () => {
      const fn = mock(async () => null);

      const result = await withIdempotency(null, fn);

      expect(result).toEqual({ status: "failed" });
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe("with idempotency key, first request", () => {
    it("acquires lock, executes, and caches the result", async () => {
      const fn = mock(async () => ({ id: "msg_1" }));

      const result = await withIdempotency("test-key", fn);

      expect(result).toEqual({ status: "executed", value: { id: "msg_1" } });
      expect(fn).toHaveBeenCalledTimes(1);
      expect(stringData.get("test-key")).toBe(JSON.stringify({ id: "msg_1" }));
    });

    it("clears lock when function returns null", async () => {
      const fn = mock(async () => null);

      const result = await withIdempotency("test-key", fn);

      expect(result).toEqual({ status: "failed" });
      expect(fn).toHaveBeenCalledTimes(1);
      expect(stringData.has("test-key")).toBe(false);
    });
  });

  describe("with idempotency key, duplicate request (cached result)", () => {
    it("returns cached result without calling function", async () => {
      stringData.set("test-key", JSON.stringify({ id: "msg_1" }));
      const fn = mock(async () => ({ id: "msg_2" }));

      const result = await withIdempotency("test-key", fn);

      expect(result).toEqual({ status: "cached", value: { id: "msg_1" } });
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe("with idempotency key, request in progress", () => {
    it("returns processing status without calling function", async () => {
      stringData.set("test-key", "processing");
      const fn = mock(async () => ({ id: "msg_2" }));

      const result = await withIdempotency("test-key", fn);

      expect(result).toEqual({ status: "processing" });
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe("with idempotency key, function throws", () => {
    it("releases the lock and rethrows the error", async () => {
      const fn = mock(async () => {
        throw new Error("send failed");
      });

      await expect(withIdempotency("test-key", fn)).rejects.toThrow(
        "send failed",
      );
      expect(fn).toHaveBeenCalledTimes(1);
      expect(stringData.has("test-key")).toBe(false);
    });
  });

  describe("with idempotency key, cache write fails after successful send", () => {
    it("releases lock and still returns executed", async () => {
      const originalSet = redis.set;
      let callCount = 0;
      (redis as any).set = mock(async () => {
        callCount++;
        if (callCount === 1) return "OK";
        throw new Error("Cache write failed");
      });

      try {
        const fn = mock(async () => ({ id: "msg_1" }));
        const result = await withIdempotency("test-key", fn);

        expect(result).toEqual({ status: "executed", value: { id: "msg_1" } });
        expect(fn).toHaveBeenCalledTimes(1);
        expect(stringData.has("test-key")).toBe(false);
      } finally {
        (redis as any).set = originalSet;
      }
    });
  });

  describe("redis failures (fail-open)", () => {
    it("executes function when lock acquire fails", async () => {
      const originalSet = redis.set;
      (redis as any).set = mock(async () => {
        throw new Error("Redis down");
      });

      try {
        const fn = mock(async () => ({ id: "msg_1" }));
        const result = await withIdempotency("test-key", fn);

        expect(result).toEqual({ status: "executed", value: { id: "msg_1" } });
        expect(fn).toHaveBeenCalledTimes(1);
      } finally {
        (redis as any).set = originalSet;
      }
    });

    it("returns processing when cache read fails after lock not acquired", async () => {
      stringData.set("test-key", "processing");
      const originalGet = redis.get;
      (redis as any).get = mock(async () => {
        throw new Error("Redis down");
      });

      try {
        const fn = mock(async () => ({ id: "msg_1" }));
        const result = await withIdempotency("test-key", fn);

        expect(result).toEqual({ status: "processing" });
        expect(fn).not.toHaveBeenCalled();
      } finally {
        (redis as any).get = originalGet;
      }
    });
  });
});
