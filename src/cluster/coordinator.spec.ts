import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import type { BaileysConnectionsHandler } from "@/baileys/connectionsHandler";
import * as redisAuthState from "@/baileys/redisAuthState";
import * as registry from "@/cluster/instanceRegistry";
import * as leaseStore from "@/cluster/leaseStore";
import config from "@/config";
import {
  BaileysConnectionOwnedElsewhereError,
  ClusterCoordinator,
} from "./coordinator";

// Spies (not mock.module) — bun's mock.module is process-global and leaks
// into the spec files that test the real implementations.
const getRedisSavedAuthStateIds = spyOn(
  redisAuthState,
  "getRedisSavedAuthStateIds",
);
const isRedisAuthStatePaired = spyOn(redisAuthState, "isRedisAuthStatePaired");
const listLiveInstances = spyOn(registry, "listLiveInstances");
const heartbeat = spyOn(registry, "heartbeat");
const deregister = spyOn(registry, "deregister");
const isInstanceAlive = spyOn(registry, "isInstanceAlive");
const acquireLease = spyOn(leaseStore, "acquireLease");
const forceAcquireLease = spyOn(leaseStore, "forceAcquireLease");
const renewLease = spyOn(leaseStore, "renewLease");
const releaseLease = spyOn(leaseStore, "releaseLease");
const getLease = spyOn(leaseStore, "getLease");
const isOnOwnReleaseCooldown = spyOn(leaseStore, "isOnOwnReleaseCooldown");
const setReleaseCooldown = spyOn(leaseStore, "setReleaseCooldown");
const setHandoffTarget = spyOn(leaseStore, "setHandoffTarget");
const getHandoffTarget = spyOn(leaseStore, "getHandoffTarget");

afterAll(() => {
  getRedisSavedAuthStateIds.mockRestore();
  isRedisAuthStatePaired.mockRestore();
  listLiveInstances.mockRestore();
  heartbeat.mockRestore();
  deregister.mockRestore();
  isInstanceAlive.mockRestore();
  acquireLease.mockRestore();
  forceAcquireLease.mockRestore();
  renewLease.mockRestore();
  releaseLease.mockRestore();
  getLease.mockRestore();
  isOnOwnReleaseCooldown.mockRestore();
  setReleaseCooldown.mockRestore();
  setHandoffTarget.mockRestore();
  getHandoffTarget.mockRestore();
});

function makeHandlerMock() {
  const connections = new Set<string>();
  const handler = {
    connections,
    connect: mock(async (phone: string) => {
      connections.add(phone);
    }),
    logout: mock(async (phone: string) => {
      connections.delete(phone);
    }),
    discardConnection: mock(async (phone: string) => {
      connections.delete(phone);
    }),
    hasConnection: (phone: string) => connections.has(phone),
    getActivePhoneNumbers: () => [...connections],
    get size() {
      return connections.size;
    },
    inFlightWebhookCount: () => 0,
  };
  return handler;
}

type HandlerMock = ReturnType<typeof makeHandlerMock>;

function makeCoordinator(
  handler: HandlerMock,
  options?: ConstructorParameters<typeof ClusterCoordinator>[1],
) {
  return new ClusterCoordinator(
    handler as unknown as BaileysConnectionsHandler,
    { shutdownTimeoutMs: 5, ...options },
  );
}

const savedEntry = (id: string) => ({
  id,
  metadata: { webhookUrl: "https://h.com", webhookVerifyToken: "t" },
});

const instanceEntry = (instanceId: string, draining = false) => ({
  instanceId,
  baseUrl: `http://${instanceId}:3025`,
  connectionCount: 0,
  draining,
  startedAt: 0,
});

describe("ClusterCoordinator", () => {
  beforeEach(() => {
    getRedisSavedAuthStateIds.mockReset();
    isRedisAuthStatePaired.mockReset();
    listLiveInstances.mockReset();
    heartbeat.mockReset();
    deregister.mockReset();
    isInstanceAlive.mockReset();
    acquireLease.mockReset();
    forceAcquireLease.mockReset();
    renewLease.mockReset();
    releaseLease.mockReset();
    getLease.mockReset();
    isOnOwnReleaseCooldown.mockReset();
    setReleaseCooldown.mockReset();
    setHandoffTarget.mockReset();
    getHandoffTarget.mockReset();

    getRedisSavedAuthStateIds.mockResolvedValue([]);
    isRedisAuthStatePaired.mockResolvedValue(true);
    listLiveInstances.mockResolvedValue([instanceEntry("test-instance")]);
    heartbeat.mockResolvedValue(undefined);
    deregister.mockResolvedValue(undefined);
    isInstanceAlive.mockResolvedValue(false);
    acquireLease.mockImplementation(async () => ({
      owner: "test-instance",
      epoch: 1,
    }));
    forceAcquireLease.mockResolvedValue({ owner: "test-instance", epoch: 1 });
    renewLease.mockResolvedValue("renewed");
    releaseLease.mockResolvedValue(true);
    getLease.mockResolvedValue(null);
    isOnOwnReleaseCooldown.mockResolvedValue(false);
    setReleaseCooldown.mockResolvedValue(undefined);
    setHandoffTarget.mockResolvedValue(undefined);
    getHandoffTarget.mockResolvedValue(null);
  });

  describe("#runClaimCycle", () => {
    it("claims and reconnects unleased paired phones with their stored metadata", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      getRedisSavedAuthStateIds.mockResolvedValue([
        savedEntry("+5511999"),
        savedEntry("+5521888"),
      ]);

      await coordinator.runClaimCycle();

      expect(acquireLease).toHaveBeenCalledTimes(2);
      expect(handler.connect).toHaveBeenCalledTimes(2);
      const [, options] = handler.connect.mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(options.isReconnect).toBe(true);
      expect(options.webhookUrl).toBe("https://h.com");
    });

    it("does not touch phones it already holds a connection for", async () => {
      const handler = makeHandlerMock();
      handler.connections.add("+5511999");
      const coordinator = makeCoordinator(handler);
      getRedisSavedAuthStateIds.mockResolvedValue([savedEntry("+5511999")]);

      await coordinator.runClaimCycle();

      expect(acquireLease).not.toHaveBeenCalled();
      expect(handler.connect).not.toHaveBeenCalled();
    });

    it("skips phones leased by any instance", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      getRedisSavedAuthStateIds.mockResolvedValue([savedEntry("+5511999")]);
      getLease.mockResolvedValue({ owner: "other-instance", epoch: 4 });

      await coordinator.runClaimCycle();

      expect(acquireLease).not.toHaveBeenCalled();
      expect(handler.connect).not.toHaveBeenCalled();
    });

    it("caps claims at the cluster fair share", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      getRedisSavedAuthStateIds.mockResolvedValue([
        savedEntry("+1"),
        savedEntry("+2"),
        savedEntry("+3"),
        savedEntry("+4"),
      ]);
      listLiveInstances.mockResolvedValue([
        instanceEntry("test-instance"),
        instanceEntry("peer-instance"),
      ]);

      await coordinator.runClaimCycle();

      // ceil(4 phones / 2 instances) = 2 — leave the rest for the peer.
      expect(handler.connect).toHaveBeenCalledTimes(2);
    });

    it("ignores the fair-share cap for phones orphaned beyond the grace window", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler, { unclaimedGraceMs: 0 });
      getRedisSavedAuthStateIds.mockResolvedValue([
        savedEntry("+1"),
        savedEntry("+2"),
        savedEntry("+3"),
        savedEntry("+4"),
      ]);
      listLiveInstances.mockResolvedValue([
        instanceEntry("test-instance"),
        instanceEntry("peer-instance"),
      ]);

      await coordinator.runClaimCycle();

      // Nobody must be left unowned: with grace elapsed, the cap yields.
      expect(handler.connect).toHaveBeenCalledTimes(4);
    });

    it("excludes draining instances from the fair-share denominator", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      getRedisSavedAuthStateIds.mockResolvedValue([
        savedEntry("+1"),
        savedEntry("+2"),
      ]);
      listLiveInstances.mockResolvedValue([
        instanceEntry("test-instance"),
        instanceEntry("dying-instance", true),
      ]);

      await coordinator.runClaimCycle();

      // ceil(2 / 1): the draining peer doesn't count, take everything.
      expect(handler.connect).toHaveBeenCalledTimes(2);
    });

    it("skips unpaired auth states (pending QR has nothing to resume)", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      getRedisSavedAuthStateIds.mockResolvedValue([savedEntry("+5511999")]);
      isRedisAuthStatePaired.mockResolvedValue(false);

      await coordinator.runClaimCycle();

      expect(acquireLease).not.toHaveBeenCalled();
      expect(handler.connect).not.toHaveBeenCalled();
    });

    it("skips phones it recently released (anti ping-pong cooldown)", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      getRedisSavedAuthStateIds.mockResolvedValue([savedEntry("+5511999")]);
      isOnOwnReleaseCooldown.mockResolvedValue(true);

      await coordinator.runClaimCycle();

      expect(acquireLease).not.toHaveBeenCalled();
    });

    it("moves on when another instance wins the SET NX race", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      getRedisSavedAuthStateIds.mockResolvedValue([savedEntry("+5511999")]);
      acquireLease.mockResolvedValue(null);

      await coordinator.runClaimCycle();

      expect(handler.connect).not.toHaveBeenCalled();
    });

    it("releases the lease when the reconnect fails", async () => {
      const handler = makeHandlerMock();
      handler.connect.mockRejectedValueOnce(new Error("boom"));
      const coordinator = makeCoordinator(handler);
      getRedisSavedAuthStateIds.mockResolvedValue([savedEntry("+5511999")]);

      await coordinator.runClaimCycle();

      expect(releaseLease).toHaveBeenCalledWith("+5511999");
    });
  });

  describe("#runRebalanceCycle", () => {
    const setupOverloaded = (handler: HandlerMock, phones: string[]) => {
      for (const phone of phones) {
        handler.connections.add(phone);
      }
      getRedisSavedAuthStateIds.mockResolvedValue(phones.map(savedEntry));
      listLiveInstances.mockResolvedValue([
        instanceEntry("test-instance"),
        { ...instanceEntry("peer-instance"), connectionCount: 0 },
      ]);
    };

    it("releases one connection to the least loaded peer with the safe ordering", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      setupOverloaded(handler, ["+1", "+2", "+3", "+4"]);
      const order: string[] = [];
      handler.discardConnection.mockImplementation(async (phone: string) => {
        handler.connections.delete(phone);
        order.push("discard");
      });
      releaseLease.mockImplementation(async () => {
        order.push("release");
        return true;
      });
      setHandoffTarget.mockImplementation(async () => {
        order.push("handoff");
      });

      await coordinator.runRebalanceCycle();

      // fairShare = ceil(4/2) = 2, held 4 > 2 + tolerance(1) → shed exactly 1.
      expect(handler.discardConnection).toHaveBeenCalledTimes(1);
      expect(releaseLease).toHaveBeenCalledTimes(1);
      expect(setHandoffTarget).toHaveBeenCalledWith(
        expect.any(String),
        "peer-instance",
      );
      // Socket down → cooldown/tombstone → lease released. Never the reverse.
      expect(order.indexOf("discard")).toBeLessThan(order.indexOf("release"));
      expect(order.indexOf("handoff")).toBeLessThan(order.indexOf("release"));
    });

    it("rate-limits releases to one per interval", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      setupOverloaded(handler, ["+1", "+2", "+3", "+4", "+5", "+6"]);

      await coordinator.runRebalanceCycle();
      await coordinator.runRebalanceCycle();

      expect(handler.discardConnection).toHaveBeenCalledTimes(1);
    });

    it("does nothing within the tolerance band", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      // fairShare = ceil(4/2) = 2; held 3 ≤ 2 + tolerance(1) → stable.
      setupOverloaded(handler, ["+1", "+2", "+3"]);
      getRedisSavedAuthStateIds.mockResolvedValue(
        ["+1", "+2", "+3", "+4"].map(savedEntry),
      );

      await coordinator.runRebalanceCycle();

      expect(handler.discardConnection).not.toHaveBeenCalled();
    });

    it("does nothing without peers", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      setupOverloaded(handler, ["+1", "+2", "+3", "+4"]);
      listLiveInstances.mockResolvedValue([instanceEntry("test-instance")]);

      await coordinator.runRebalanceCycle();

      expect(handler.discardConnection).not.toHaveBeenCalled();
    });

    it("defers to an in-progress failover (recent claims)", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      // A claim cycle that lands claims marks lastClaimAt = now.
      getRedisSavedAuthStateIds.mockResolvedValue([savedEntry("+0")]);
      await coordinator.runClaimCycle();

      setupOverloaded(handler, ["+1", "+2", "+3", "+4"]);

      await coordinator.runRebalanceCycle();

      expect(handler.discardConnection).not.toHaveBeenCalled();
    });

    it("never moves a pending-QR connection", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      setupOverloaded(handler, ["+1", "+2", "+3", "+4"]);
      isRedisAuthStatePaired.mockResolvedValue(false);

      await coordinator.runRebalanceCycle();

      expect(handler.discardConnection).not.toHaveBeenCalled();
    });
  });

  describe("handoff tombstones in the claim cycle", () => {
    it("skips phones whose tombstone names another instance", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      getRedisSavedAuthStateIds.mockResolvedValue([savedEntry("+5511999")]);
      getHandoffTarget.mockResolvedValue("peer-instance");

      await coordinator.runClaimCycle();

      expect(acquireLease).not.toHaveBeenCalled();
    });

    it("claims a phone directed at itself even past the fair-share cap", async () => {
      const handler = makeHandlerMock();
      handler.connections.add("+1").add("+2");
      const coordinator = makeCoordinator(handler);
      getRedisSavedAuthStateIds.mockResolvedValue(
        ["+1", "+2", "+3", "+4"].map(savedEntry),
      );
      listLiveInstances.mockResolvedValue([
        instanceEntry("test-instance"),
        instanceEntry("peer-instance"),
      ]);
      // fairShare = 2 and we already hold 2 — but +3 is directed at us.
      getHandoffTarget.mockImplementation(async (phone: string) =>
        phone === "+3" ? "test-instance" : null,
      );

      await coordinator.runClaimCycle();

      expect(handler.connect).toHaveBeenCalledTimes(1);
      expect(handler.connect.mock.calls[0][0]).toBe("+3");
    });
  });

  describe("#runRenewCycle", () => {
    it("renews leases for all locally held connections", async () => {
      const handler = makeHandlerMock();
      handler.connections.add("+1").add("+2");
      const coordinator = makeCoordinator(handler);

      await coordinator.runRenewCycle();

      expect(renewLease).toHaveBeenCalledTimes(2);
      expect(handler.discardConnection).not.toHaveBeenCalled();
    });

    it("self-fences when the lease is owned elsewhere", async () => {
      const handler = makeHandlerMock();
      handler.connections.add("+5511999");
      const coordinator = makeCoordinator(handler);
      renewLease.mockResolvedValue("lost");

      await coordinator.runRenewCycle();

      expect(handler.discardConnection).toHaveBeenCalledWith("+5511999");
    });

    it("re-asserts a missing lease without dropping the socket", async () => {
      // Redis failover (or TTL elapsing while degraded) loses the key. The
      // sitting owner re-acquires and keeps the socket — no churn.
      const handler = makeHandlerMock();
      handler.connections.add("+5511999");
      const coordinator = makeCoordinator(handler);
      renewLease.mockResolvedValue("missing");

      await coordinator.runRenewCycle();

      expect(acquireLease).toHaveBeenCalledWith("+5511999");
      expect(handler.discardConnection).not.toHaveBeenCalled();
    });

    it("fences when the missing lease was already taken by someone else", async () => {
      const handler = makeHandlerMock();
      handler.connections.add("+5511999");
      const coordinator = makeCoordinator(handler);
      renewLease.mockResolvedValue("missing");
      acquireLease.mockResolvedValue(null);

      await coordinator.runRenewCycle();

      expect(handler.discardConnection).toHaveBeenCalledWith("+5511999");
    });

    it("keeps sockets alive when Redis is unreachable and pauses claims", async () => {
      // Mass self-fencing on a Redis blip would be a self-inflicted outage —
      // the sockets do not need Redis to keep working.
      const handler = makeHandlerMock();
      handler.connections.add("+5511999");
      const coordinator = makeCoordinator(handler);
      renewLease.mockRejectedValue(new Error("redis down"));

      await coordinator.runRenewCycle();
      expect(handler.discardConnection).not.toHaveBeenCalled();

      // Claims stay paused while degraded: our view of the cluster is stale.
      getRedisSavedAuthStateIds.mockClear();
      await coordinator.runClaimCycle();
      expect(getRedisSavedAuthStateIds).not.toHaveBeenCalled();

      // A successful renewal clears the degraded flag and claims resume.
      renewLease.mockResolvedValue("renewed");
      await coordinator.runRenewCycle();
      await coordinator.runClaimCycle();
      expect(getRedisSavedAuthStateIds).toHaveBeenCalled();
    });
  });

  describe("#connectWithLease", () => {
    it("force-acquires the lease and connects", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      const options = { webhookUrl: "https://h.com", webhookVerifyToken: "t" };

      await coordinator.connectWithLease("+5511999", options);

      expect(forceAcquireLease).toHaveBeenCalledWith("+5511999");
      expect(handler.connect).toHaveBeenCalledWith("+5511999", options);
    });

    describe("in worker role", () => {
      // config is the shared preload mock — restore the role even if a test
      // throws, or every spec file that runs after this one sees "worker".
      const withWorkerRole = async (fn: () => Promise<void>) => {
        config.cluster.role = "worker";
        try {
          await fn();
        } finally {
          config.cluster.role = "standalone";
        }
      };

      it("refuses to steal a lease held by a live instance", async () => {
        await withWorkerRole(async () => {
          const handler = makeHandlerMock();
          const coordinator = makeCoordinator(handler);
          getLease.mockResolvedValue({ owner: "peer-instance", epoch: 3 });
          isInstanceAlive.mockResolvedValue(true);

          await expect(
            coordinator.connectWithLease("+5511999", {
              webhookUrl: "https://h.com",
              webhookVerifyToken: "t",
            }),
          ).rejects.toThrow(BaileysConnectionOwnedElsewhereError);

          expect(forceAcquireLease).not.toHaveBeenCalled();
          expect(handler.connect).not.toHaveBeenCalled();
        });
      });

      it("force-takes a lease whose owner is dead", async () => {
        await withWorkerRole(async () => {
          const handler = makeHandlerMock();
          const coordinator = makeCoordinator(handler);
          getLease.mockResolvedValue({ owner: "dead-instance", epoch: 3 });
          isInstanceAlive.mockResolvedValue(false);

          await coordinator.connectWithLease("+5511999", {
            webhookUrl: "https://h.com",
            webhookVerifyToken: "t",
          });

          expect(forceAcquireLease).toHaveBeenCalledWith("+5511999");
          expect(handler.connect).toHaveBeenCalled();
        });
      });

      it("proceeds when it already owns the lease", async () => {
        await withWorkerRole(async () => {
          const handler = makeHandlerMock();
          const coordinator = makeCoordinator(handler);
          getLease.mockResolvedValue({ owner: "test-instance", epoch: 3 });

          await coordinator.connectWithLease("+5511999", {
            webhookUrl: "https://h.com",
            webhookVerifyToken: "t",
          });

          expect(handler.connect).toHaveBeenCalled();
        });
      });
    });
  });

  describe("#logoutWithLease", () => {
    it("logs out and releases the lease", async () => {
      const handler = makeHandlerMock();
      handler.connections.add("+5511999");
      const coordinator = makeCoordinator(handler);

      await coordinator.logoutWithLease("+5511999");

      expect(handler.logout).toHaveBeenCalledWith("+5511999");
      expect(releaseLease).toHaveBeenCalledWith("+5511999");
    });

    it("releases the lease even when logout throws", async () => {
      const handler = makeHandlerMock();
      handler.logout.mockRejectedValueOnce(new Error("not connected"));
      const coordinator = makeCoordinator(handler);

      await expect(coordinator.logoutWithLease("+5511999")).rejects.toThrow(
        "not connected",
      );
      expect(releaseLease).toHaveBeenCalledWith("+5511999");
    });
  });

  describe("#shutdown", () => {
    it("announces draining, discards sockets before releasing leases, and deregisters", async () => {
      const handler = makeHandlerMock();
      handler.connections.add("+1").add("+2");
      const coordinator = makeCoordinator(handler);
      const order: string[] = [];
      handler.discardConnection.mockImplementation(async (phone: string) => {
        handler.connections.delete(phone);
        order.push(`discard:${phone}`);
      });
      releaseLease.mockImplementation(async (phone: string) => {
        order.push(`release:${phone}`);
        return true;
      });

      await coordinator.shutdown();

      expect(heartbeat).toHaveBeenCalledWith(
        expect.objectContaining({ draining: true }),
      );
      expect(handler.discardConnection).toHaveBeenCalledTimes(2);
      expect(releaseLease).toHaveBeenCalledTimes(2);
      // For each phone the socket closes BEFORE the lease is released, so the
      // next owner can never overlap with a still-open socket.
      for (const phone of ["+1", "+2"]) {
        expect(order.indexOf(`discard:${phone}`)).toBeLessThan(
          order.indexOf(`release:${phone}`),
        );
      }
      expect(deregister).toHaveBeenCalled();
    });

    it("stops claiming once draining", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      await coordinator.shutdown();

      getRedisSavedAuthStateIds.mockClear();
      await coordinator.runClaimCycle();

      expect(getRedisSavedAuthStateIds).not.toHaveBeenCalled();
    });
  });
});
