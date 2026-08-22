import { afterEach, describe, expect, it, mock } from "bun:test";
import { incarnationId } from "@/cluster/identity";
import { clusterKeys } from "@/cluster/keys";
import redis from "@/lib/redis";
import { withIdempotency } from "./withIdempotency";

const stringData = (redis as any).__stringData as Map<string, string>;
const expirations = (redis as any).__expirations as Map<
  string,
  { type: string; value: number }
>;

// instanceId resolves to "test-instance" via the mocked config in preload.ts.
const SELF = "test-instance";
// The marker this process writes for its own in-flight work.
const SELF_MARKER = `processing:${SELF}#${incarnationId}`;

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 5));

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

  describe("in-flight marker carries the holder instance id", () => {
    it("tags the processing marker with this instance id while running", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fn = mock(async () => {
        await gate;
        return { id: "msg_1" };
      });

      const pending = withIdempotency("test-key", fn);
      await flushMicrotasks();

      expect(stringData.get("test-key")).toBe(SELF_MARKER);

      release();
      const result = await pending;
      expect(result).toEqual({ status: "executed", value: { id: "msg_1" } });
    });
  });

  describe("orphaned lock reclaim (dead holder)", () => {
    it("steals a lock held by a dead instance and executes", async () => {
      // Marker left behind by a worker that crashed mid-send. The holder is
      // not in the registry, so it is safe to reclaim.
      stringData.set("test-key", "processing:dead-instance");
      const fn = mock(async () => ({ id: "msg_1" }));

      const result = await withIdempotency("test-key", fn);

      expect(result).toEqual({ status: "executed", value: { id: "msg_1" } });
      expect(fn).toHaveBeenCalledTimes(1);
      expect(stringData.get("test-key")).toBe(JSON.stringify({ id: "msg_1" }));
    });

    it("does not steal a lock held by a live instance", async () => {
      stringData.set("test-key", "processing:live-instance");
      // A heartbeat key makes the holder appear alive in the registry.
      stringData.set(clusterKeys.instance("live-instance"), "{}");
      const fn = mock(async () => ({ id: "msg_2" }));

      const result = await withIdempotency("test-key", fn);

      expect(result).toEqual({ status: "processing" });
      expect(fn).not.toHaveBeenCalled();
    });

    it("does not steal its own in-flight lock", async () => {
      stringData.set("test-key", SELF_MARKER);
      const fn = mock(async () => ({ id: "msg_2" }));

      const result = await withIdempotency("test-key", fn);

      expect(result).toEqual({ status: "processing" });
      expect(fn).not.toHaveBeenCalled();
    });

    it("steals a lock left by its own previous (dead) incarnation", async () => {
      // Same instanceId, different incarnation: a restart under a pinned
      // INSTANCE_ID. The registry now points at the live (current) process
      // under that id, so liveness cannot prove the old holder dead — the
      // incarnation mismatch does. No instance key is needed here.
      stringData.set("test-key", `processing:${SELF}#stale-incarnation`);
      const fn = mock(async () => ({ id: "msg_1" }));

      const result = await withIdempotency("test-key", fn);

      expect(result).toEqual({ status: "executed", value: { id: "msg_1" } });
      expect(fn).toHaveBeenCalledTimes(1);
      expect(stringData.get("test-key")).toBe(JSON.stringify({ id: "msg_1" }));
    });

    it("does not steal its own live incarnation even via the holder path", async () => {
      // Guard against the incarnation check misfiring: our current marker must
      // never be treated as a dead previous incarnation.
      stringData.set("test-key", SELF_MARKER);
      // A heartbeat key for ourselves should not change the outcome.
      stringData.set(clusterKeys.instance(SELF), "{}");
      const fn = mock(async () => ({ id: "msg_2" }));

      const result = await withIdempotency("test-key", fn);

      expect(result).toEqual({ status: "processing" });
      expect(fn).not.toHaveBeenCalled();
    });

    it("keeps a colon-containing instanceId intact (does not steal a live one)", async () => {
      // The "#" delimiter must not be confused with colons inside the
      // instanceId: holder is "host:9000", which is alive, so no steal. A
      // naive ":" split would read the holder as "host" (not alive) and
      // wrongly reclaim the lock.
      stringData.set("test-key", "processing:host:9000#abc123");
      stringData.set(clusterKeys.instance("host:9000"), "{}");
      const fn = mock(async () => ({ id: "msg_2" }));

      const result = await withIdempotency("test-key", fn);

      expect(result).toEqual({ status: "processing" });
      expect(fn).not.toHaveBeenCalled();
    });

    it("does not steal a legacy bare 'processing' marker (unknown holder)", async () => {
      stringData.set("test-key", "processing");
      const fn = mock(async () => ({ id: "msg_2" }));

      const result = await withIdempotency("test-key", fn);

      expect(result).toEqual({ status: "processing" });
      expect(fn).not.toHaveBeenCalled();
    });

    it("does not steal when liveness cannot be confirmed", async () => {
      stringData.set("test-key", "processing:dead-instance");
      const originalExists = redis.exists;
      (redis as any).exists = mock(async () => {
        throw new Error("Redis down");
      });

      try {
        const fn = mock(async () => ({ id: "msg_2" }));
        const result = await withIdempotency("test-key", fn);

        expect(result).toEqual({ status: "processing" });
        expect(fn).not.toHaveBeenCalled();
      } finally {
        (redis as any).exists = originalExists;
      }
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

  describe("indeterminate outcomes", () => {
    const KEY = "@baileys-api:idempotency:send-message:+55:1";

    // A timed-out send is not cancelled — it stays parked in the socket's
    // keystore mutex and may still reach WhatsApp. Deleting the key would let a
    // retry duplicate the message; keeping "processing" would 409 blindly for
    // the full TTL. Neither is right, so the state is recorded distinctly.
    it("marks the key indeterminate instead of releasing it", async () => {
      const error = new Error("timed out");

      await expect(
        withIdempotency(
          KEY,
          async () => {
            throw error;
          },
          { isIndeterminate: () => true },
        ),
      ).rejects.toBe(error);

      expect(stringData.get(KEY)).toStartWith("indeterminate:");
    });

    // The marker has to outlive both the abandoned operation (nothing cancels it; it
    // sits in the keystore mutex until that socket dies) and the person reconciling
    // it. On the cached-result TTL, a send that landed 11 minutes late would find its
    // marker gone and let a retry duplicate the message — the exact outcome the
    // marker exists to prevent.
    it("keeps the indeterminate marker far longer than a cached result", async () => {
      await expect(
        withIdempotency(
          KEY,
          async () => {
            throw new Error("timed out");
          },
          { isIndeterminate: () => true },
        ),
      ).rejects.toThrow();

      expect(expirations.get(KEY)).toEqual({ type: "EX", value: 86_400 });

      await withIdempotency("other-key", async () => ({ ok: true }));
      expect(expirations.get("other-key")).toEqual({ type: "EX", value: 600 });
    });

    it("still releases the key when the failure is conclusive", async () => {
      const error = new Error("bad request");

      await expect(
        withIdempotency(
          KEY,
          async () => {
            throw error;
          },
          { isIndeterminate: () => false },
        ),
      ).rejects.toBe(error);

      expect(stringData.has(KEY)).toBe(false);
    });

    it("reports indeterminate to a later caller instead of re-running the work", async () => {
      await withIdempotency(
        KEY,
        async () => {
          throw new Error("timed out");
        },
        { isIndeterminate: () => true },
      ).catch(() => {});

      const fn = mock(async () => ({ id: "msg_1" }));
      const result = await withIdempotency(KEY, fn);

      expect(result).toEqual({ status: "indeterminate" });
      expect(fn).not.toHaveBeenCalled();
    });

    // Deliberately no steal path: a dead holder tells us nothing about whether
    // its send reached WhatsApp, so the outcome stays unknown.
    it("never steals an indeterminate marker, even from a dead instance", async () => {
      stringData.set(KEY, "indeterminate:some-dead-instance#abc");

      const fn = mock(async () => ({ id: "msg_1" }));
      const result = await withIdempotency(KEY, fn);

      expect(result).toEqual({ status: "indeterminate" });
      expect(fn).not.toHaveBeenCalled();
    });

    it("defaults to releasing the lock when no predicate is given", async () => {
      await withIdempotency(KEY, async () => {
        throw new Error("boom");
      }).catch(() => {});

      expect(stringData.has(KEY)).toBe(false);
    });
  });
});
