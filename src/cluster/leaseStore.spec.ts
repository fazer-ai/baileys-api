import { beforeEach, describe, expect, it } from "bun:test";
import redis from "@/lib/redis";
import { clusterKeys } from "./keys";
import * as leaseStore from "./leaseStore";

// The compare-owner semantics of renew/release live in Lua and run inside
// Redis; here we cover the JS wrapper: key naming, payload shape, argument
// wiring and result mapping. redis.eval is a preload mock whose return value
// each test pins to the script outcome it simulates.

const PHONE = "+5511999999999";
const leaseKey = clusterKeys.lease(PHONE);
const stringData = (redis as unknown as { __stringData: Map<string, string> })
  .__stringData;

describe("leaseStore", () => {
  beforeEach(() => {
    stringData.clear();
    (redis.set as ReturnType<typeof import("bun:test").mock>).mockClear();
    (redis.incr as ReturnType<typeof import("bun:test").mock>).mockClear();
    (redis.eval as ReturnType<typeof import("bun:test").mock>).mockClear();
  });

  describe("#acquireLease", () => {
    it("acquires an unleased phone and stores owner+epoch", async () => {
      const lease = await leaseStore.acquireLease(PHONE);

      expect(lease).toEqual({ owner: "test-instance", epoch: 1 });
      expect(JSON.parse(stringData.get(leaseKey) ?? "{}")).toEqual({
        owner: "test-instance",
        epoch: 1,
      });
    });

    it("returns null when the phone is already leased", async () => {
      stringData.set(leaseKey, JSON.stringify({ owner: "other", epoch: 3 }));

      const lease = await leaseStore.acquireLease(PHONE);

      expect(lease).toBeNull();
      // Loser must not overwrite the holder.
      expect(JSON.parse(stringData.get(leaseKey) ?? "{}").owner).toBe("other");
    });

    it("epochs strictly increase across successive acquires", async () => {
      const first = await leaseStore.acquireLease(PHONE);
      stringData.delete(leaseKey); // simulate TTL expiry
      const second = await leaseStore.acquireLease(PHONE);

      expect(second?.epoch ?? 0).toBeGreaterThan(first?.epoch ?? 0);
    });
  });

  describe("#forceAcquireLease", () => {
    it("takes the lease over even when held by another instance", async () => {
      stringData.set(leaseKey, JSON.stringify({ owner: "other", epoch: 3 }));

      const lease = await leaseStore.forceAcquireLease(PHONE);

      expect(lease.owner).toBe("test-instance");
      expect(JSON.parse(stringData.get(leaseKey) ?? "{}").owner).toBe(
        "test-instance",
      );
    });
  });

  describe("#renewLease", () => {
    const evalMock = redis.eval as unknown as ReturnType<
      typeof import("bun:test").mock
    >;

    it("maps script result 1 to renewed", async () => {
      evalMock.mockResolvedValueOnce(1);
      expect(await leaseStore.renewLease(PHONE)).toBe("renewed");
    });

    it("maps script result 0 to lost", async () => {
      evalMock.mockResolvedValueOnce(0);
      expect(await leaseStore.renewLease(PHONE)).toBe("lost");
    });

    it("maps script result -1 to missing", async () => {
      evalMock.mockResolvedValueOnce(-1);
      expect(await leaseStore.renewLease(PHONE)).toBe("missing");
    });

    it("passes the lease key, instance id and TTL to the script", async () => {
      evalMock.mockResolvedValueOnce(1);
      await leaseStore.renewLease(PHONE);

      const [, options] = evalMock.mock.calls.at(-1) as [
        string,
        { keys: string[]; arguments: string[] },
      ];
      expect(options.keys).toEqual([leaseKey]);
      expect(options.arguments[0]).toBe("test-instance");
      expect(Number(options.arguments[1])).toBeGreaterThan(0);
    });

    it("propagates transport errors instead of mapping them", async () => {
      evalMock.mockRejectedValueOnce(new Error("redis down"));
      await expect(leaseStore.renewLease(PHONE)).rejects.toThrow("redis down");
    });
  });

  describe("#releaseLease", () => {
    const evalMock = redis.eval as unknown as ReturnType<
      typeof import("bun:test").mock
    >;

    it("returns true when the script deleted the lease", async () => {
      evalMock.mockResolvedValueOnce(1);
      expect(await leaseStore.releaseLease(PHONE, 1)).toBe(true);
    });

    it("returns false when the lease belongs to someone else or epochs differ", async () => {
      evalMock.mockResolvedValueOnce(0);
      expect(await leaseStore.releaseLease(PHONE, 1)).toBe(false);
    });

    it("passes the lease key, instance id and expected epoch to the script", async () => {
      evalMock.mockResolvedValueOnce(1);
      await leaseStore.releaseLease(PHONE, 7);

      const [, options] = evalMock.mock.calls.at(-1) as [
        string,
        { keys: string[]; arguments: string[] },
      ];
      expect(options.keys).toEqual([leaseKey]);
      expect(options.arguments).toEqual(["test-instance", "7"]);
    });
  });

  describe("#getLease", () => {
    it("parses the stored lease", async () => {
      stringData.set(leaseKey, JSON.stringify({ owner: "other", epoch: 9 }));
      expect(await leaseStore.getLease(PHONE)).toEqual({
        owner: "other",
        epoch: 9,
      });
    });

    it("returns null when unleased", async () => {
      expect(await leaseStore.getLease(PHONE)).toBeNull();
    });
  });

  describe("release cooldown", () => {
    it("only throttles the instance that released", async () => {
      await leaseStore.setReleaseCooldown(PHONE);
      expect(await leaseStore.isOnOwnReleaseCooldown(PHONE)).toBe(true);

      stringData.set(clusterKeys.cooldown(PHONE), "some-other-instance");
      expect(await leaseStore.isOnOwnReleaseCooldown(PHONE)).toBe(false);
    });
  });
});
