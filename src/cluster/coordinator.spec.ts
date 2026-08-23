import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { BaileysNotConnectedError } from "@/baileys/connection";
import type { BaileysConnectionsHandler } from "@/baileys/connectionsHandler";
import * as redisAuthState from "@/baileys/redisAuthState";
import * as registry from "@/cluster/instanceRegistry";
import * as leaseStore from "@/cluster/leaseStore";
import * as quarantineStore from "@/cluster/quarantineStore";
import * as sendStallStore from "@/cluster/sendStallStore";
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
const seedImportedSession = spyOn(redisAuthState, "seedImportedSession");
const clearRedisAuthState = spyOn(redisAuthState, "clearRedisAuthState");
const getRedisAuthMetadata = spyOn(redisAuthState, "getRedisAuthMetadata");
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
const isQuarantined = spyOn(quarantineStore, "isQuarantined");
const clearQuarantine = spyOn(quarantineStore, "clearQuarantine");
const clearSendStall = spyOn(sendStallStore, "clearSendStall");

afterAll(() => {
  getRedisSavedAuthStateIds.mockRestore();
  isRedisAuthStatePaired.mockRestore();
  seedImportedSession.mockRestore();
  clearRedisAuthState.mockRestore();
  getRedisAuthMetadata.mockRestore();
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
  isQuarantined.mockRestore();
  clearQuarantine.mockRestore();
  clearSendStall.mockRestore();
});

function makeHandlerMock() {
  const connections = new Set<string>();
  const activity = new Map<
    string,
    { inFlightWebhooks: number; lastTrafficAt: number | null }
  >();
  // What a live connection currently answers for currentOptions -- which a POST
  // /connections mutates in place, so it is not what the connection was spawned
  // with and not necessarily what Redis holds.
  const liveOptions = new Map<string, Record<string, unknown>>();
  const handler = {
    connections,
    activity,
    // Returns true like the real connect: false means only "shouldProceed vetoed
    // it", and a double that answered undefined would report every restart as
    // skipped.
    connect: mock(async (phone: string, _options?: unknown) => {
      connections.add(phone);
      return true;
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
    updateLeaseEpoch: mock(async (_phone: string, _epoch: number) => {}),
    liveOptions,
    currentConnectionOptions: (phone: string) =>
      connections.has(phone) ? (liveOptions.get(phone) ?? null) : null,
    inFlightWebhookCount: () => 0,
    connectionActivity: (phone: string) =>
      connections.has(phone)
        ? (activity.get(phone) ?? { inFlightWebhooks: 0, lastTrafficAt: null })
        : null,
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
    seedImportedSession.mockReset();
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
    isQuarantined.mockReset();
    clearQuarantine.mockReset();
    clearSendStall.mockReset();
    clearRedisAuthState.mockReset();
    getRedisAuthMetadata.mockReset();

    getRedisSavedAuthStateIds.mockResolvedValue([]);
    isRedisAuthStatePaired.mockResolvedValue(true);
    seedImportedSession.mockResolvedValue(true);
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
    isQuarantined.mockResolvedValue(false);
    clearQuarantine.mockResolvedValue(undefined);
    clearSendStall.mockResolvedValue(undefined);
    clearRedisAuthState.mockResolvedValue(true);
    getRedisAuthMetadata.mockResolvedValue(null);
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
      // Epoch of the acquireLease that authorized this reconnect.
      expect(options.leaseEpoch).toBe(1);
    });

    it("skips quarantined phones and claims them again once quarantine lapses", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      getRedisSavedAuthStateIds.mockResolvedValue([savedEntry("+5511999")]);
      isQuarantined.mockResolvedValue(true);

      await coordinator.runClaimCycle();

      // Claiming a quarantined phone would restart the exact reconnect
      // livelock the quarantine is throttling.
      expect(acquireLease).not.toHaveBeenCalled();
      expect(handler.connect).not.toHaveBeenCalled();

      isQuarantined.mockResolvedValue(false);
      await coordinator.runClaimCycle();

      expect(acquireLease).toHaveBeenCalledTimes(1);
      expect(handler.connect).toHaveBeenCalledTimes(1);
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

    it("skips the claim cycle when the registry read fails", async () => {
      // liveCount = 1 on a registry outage would let this node bypass the
      // fair-share cap and grab the whole cluster with a stale view.
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      getRedisSavedAuthStateIds.mockResolvedValue([savedEntry("+5511999")]);
      listLiveInstances.mockRejectedValue(new Error("redis down"));

      await coordinator.runClaimCycle();

      expect(acquireLease).not.toHaveBeenCalled();
      expect(handler.connect).not.toHaveBeenCalled();
    });

    it("releases freshly claimed leases when shutdown starts mid-cycle", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      getRedisSavedAuthStateIds.mockResolvedValue([savedEntry("+5511999")]);
      getLease.mockImplementation(async () => {
        // SIGTERM lands while the cycle is scanning candidates. shutdown()
        // flips draining synchronously before its first await.
        void coordinator.shutdown();
        return null;
      });

      await coordinator.runClaimCycle();

      // The lease was acquired but never reached the handler, so the
      // shutdown handoff cannot see it — the cycle itself must release it.
      expect(handler.connect).not.toHaveBeenCalled();
      expect(releaseLease).toHaveBeenCalledWith("+5511999", 1);
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

      // Released under the epoch acquired in this same cycle.
      expect(releaseLease).toHaveBeenCalledWith("+5511999", 1);
    });

    // An explicit connect, import or restart can force-acquire its own lease
    // while this spawn is awaiting. The pre-connect guard catches that race
    // before the attempt, but nothing stops it landing during one -- and
    // releasing by "whatever we hold now" would hand away that operation's lease,
    // leaving its live socket with nobody renewing it and free for any claim loop
    // to take.
    it("releases the failed claim's own epoch, not a newer one", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      handler.connect.mockImplementationOnce(async () => {
        // A concurrent explicit operation force-acquires while we are awaiting.
        (
          coordinator as unknown as { heldLeaseEpochs: Map<string, number> }
        ).heldLeaseEpochs.set("+5511999", 9);
        throw new Error("boom");
      });
      getRedisSavedAuthStateIds.mockResolvedValue([savedEntry("+5511999")]);

      await coordinator.runClaimCycle();

      expect(releaseLease).toHaveBeenCalledWith("+5511999", 1);
      expect(releaseLease).not.toHaveBeenCalledWith("+5511999", 9);
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
      // Connections added directly (not via a claim cycle) have no tracked
      // epoch; releaseHeldLease falls back to the stored lease, which must
      // belong to this instance for the release to proceed.
      getLease.mockResolvedValue({ owner: "test-instance", epoch: 7 });
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
      setReleaseCooldown.mockImplementation(async () => {
        order.push("cooldown");
      });

      await coordinator.runRebalanceCycle();

      // fairShare = ceil(4/2) = 2, held 4 > 2 + tolerance(1) → shed exactly 1.
      expect(handler.discardConnection).toHaveBeenCalledTimes(1);
      expect(releaseLease).toHaveBeenCalledTimes(1);
      // Compare-and-delete under the epoch of the stored lease (fallback for
      // an untracked claim).
      expect(releaseLease).toHaveBeenCalledWith(expect.any(String), 7);
      expect(setHandoffTarget).toHaveBeenCalledWith(
        expect.any(String),
        "peer-instance",
      );
      // Socket down → cooldown/tombstone → lease released. Never the reverse.
      expect(order.indexOf("discard")).toBeLessThan(order.indexOf("cooldown"));
      expect(order.indexOf("cooldown")).toBeLessThan(order.indexOf("release"));
      expect(order.indexOf("handoff")).toBeLessThan(order.indexOf("release"));
    });

    it("still releases the lease when the handoff metadata write fails", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      setupOverloaded(handler, ["+1", "+2", "+3", "+4"]);
      setHandoffTarget.mockRejectedValue(new Error("redis blip"));

      await coordinator.runRebalanceCycle();

      // A discarded socket must never keep its lease: the cooldown/tombstone
      // writes only steer placement, so their failure degrades to an
      // undirected release instead of a blackhole until the TTL.
      expect(handler.discardConnection).toHaveBeenCalledTimes(1);
      expect(releaseLease).toHaveBeenCalledTimes(1);
      expect(releaseLease).toHaveBeenCalledWith(expect.any(String), 7);
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

    describe("idle awareness", () => {
      it("prefers an idle victim over recently active connections", async () => {
        const handler = makeHandlerMock();
        const coordinator = makeCoordinator(handler);
        setupOverloaded(handler, ["+1", "+2", "+3", "+4"]);
        const now = performance.now();
        handler.activity.set("+1", { inFlightWebhooks: 0, lastTrafficAt: now });
        handler.activity.set("+2", { inFlightWebhooks: 0, lastTrafficAt: now });
        handler.activity.set("+3", { inFlightWebhooks: 0, lastTrafficAt: now });
        // +4 never saw traffic — the only invisible migration.

        await coordinator.runRebalanceCycle();

        expect(handler.discardConnection).toHaveBeenCalledTimes(1);
        expect(handler.discardConnection.mock.calls[0][0]).toBe("+4");
      });

      it("defers when every connection is mid-conversation", async () => {
        const handler = makeHandlerMock();
        const coordinator = makeCoordinator(handler);
        // 4 held, fair share 2 — over share but not past the force factor
        // (4 ≤ 2×2), so it waits for a quiet window.
        setupOverloaded(handler, ["+1", "+2", "+3", "+4"]);
        const now = performance.now();
        for (const phone of ["+1", "+2", "+3", "+4"]) {
          handler.activity.set(phone, {
            inFlightWebhooks: 0,
            lastTrafficAt: now,
          });
        }

        await coordinator.runRebalanceCycle();

        expect(handler.discardConnection).not.toHaveBeenCalled();
      });

      it("treats in-flight webhooks as activity", async () => {
        const handler = makeHandlerMock();
        const coordinator = makeCoordinator(handler);
        setupOverloaded(handler, ["+1", "+2", "+3", "+4"]);
        for (const phone of ["+1", "+2", "+3", "+4"]) {
          handler.activity.set(phone, {
            inFlightWebhooks: 1,
            lastTrafficAt: null,
          });
        }

        await coordinator.runRebalanceCycle();

        expect(handler.discardConnection).not.toHaveBeenCalled();
      });

      it("forces the least active migration far above the fair share", async () => {
        const handler = makeHandlerMock();
        const coordinator = makeCoordinator(handler);
        const phones = ["+1", "+2", "+3", "+4", "+5", "+6", "+7", "+8"];
        for (const phone of phones) {
          handler.connections.add(phone);
        }
        getRedisSavedAuthStateIds.mockResolvedValue(phones.map(savedEntry));
        // 3 live instances → fair share ceil(8/3) = 3; held 8 > 3×2 → forced.
        listLiveInstances.mockResolvedValue([
          instanceEntry("test-instance"),
          { ...instanceEntry("peer-a"), connectionCount: 0 },
          { ...instanceEntry("peer-b"), connectionCount: 0 },
        ]);
        getLease.mockResolvedValue({ owner: "test-instance", epoch: 7 });
        const now = performance.now();
        phones.forEach((phone, i) => {
          // All actively trafficked — +1 least recently.
          handler.activity.set(phone, {
            inFlightWebhooks: 0,
            lastTrafficAt: now - 1000 + i,
          });
        });

        await coordinator.runRebalanceCycle();

        expect(handler.discardConnection).toHaveBeenCalledTimes(1);
        expect(handler.discardConnection.mock.calls[0][0]).toBe("+1");
      });
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

    // heldLeaseEpochs is not the only holder of the epoch. The socket stamps its
    // connection.update webhooks with the one it was given, and it is what
    // onSpawnFailed hands to abandonExplicitLease when a background reconnect
    // gives up. That release is epoch-fenced on both sides, so leaving the socket
    // on the pre-re-acquire epoch turns the release into a silent no-op and the
    // lease we just took back sits held with no socket behind it until its TTL.
    it("hands the re-acquired epoch to the socket, not just to its own map", async () => {
      const handler = makeHandlerMock();
      handler.connections.add("+5511999");
      const coordinator = makeCoordinator(handler);
      renewLease.mockResolvedValue("missing");
      acquireLease.mockResolvedValue({ owner: "test-instance", epoch: 7 });

      await coordinator.runRenewCycle();

      expect(handler.updateLeaseEpoch).toHaveBeenCalledWith("+5511999", 7);
    });

    // A metadata write that fails is not evidence that Redis is down -- the renew
    // and the re-acquire both just succeeded through it. Letting it reach the
    // outer catch would pause every claim in the cluster over a write that only
    // affects one socket's epoch stamp.
    it("keeps going when the epoch cannot be propagated", async () => {
      const handler = makeHandlerMock();
      handler.connections.add("+5511999");
      const coordinator = makeCoordinator(handler);
      renewLease.mockResolvedValue("missing");
      acquireLease.mockResolvedValue({ owner: "test-instance", epoch: 7 });
      handler.updateLeaseEpoch.mockRejectedValueOnce(new Error("redis down"));

      await coordinator.runRenewCycle();

      expect(handler.discardConnection).not.toHaveBeenCalled();
      // Not degraded: claims keep running.
      getRedisSavedAuthStateIds.mockClear();
      await coordinator.runClaimCycle();
      expect(getRedisSavedAuthStateIds).toHaveBeenCalled();
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

    it("recovers from degradation on an idle worker via a direct probe", async () => {
      // With zero active phones there are no renewals to clear the flag, so
      // a recovered Redis would otherwise leave claims paused forever.
      const handler = makeHandlerMock();
      handler.connections.add("+5511999");
      const coordinator = makeCoordinator(handler);
      renewLease.mockRejectedValue(new Error("redis down"));
      await coordinator.runRenewCycle();

      // The only connection goes away while degraded (e.g. 440 lease gate).
      handler.connections.delete("+5511999");
      getRedisSavedAuthStateIds.mockClear();
      await coordinator.runClaimCycle();
      expect(getRedisSavedAuthStateIds).not.toHaveBeenCalled();

      // Next renew tick has nothing to renew but probes Redis and recovers.
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
      // The epoch from the force-acquire is threaded into the connection so
      // its webhooks are stamped with the claim that authorized the socket.
      expect(handler.connect).toHaveBeenCalledWith("+5511999", {
        ...options,
        leaseEpoch: 1,
      });
    });

    it("clears quarantine — explicit intent must retry immediately", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);

      await coordinator.connectWithLease("+5511999", {
        webhookUrl: "https://h.com",
        webhookVerifyToken: "t",
      });

      expect(clearQuarantine).toHaveBeenCalledWith("+5511999");
      expect(handler.connect).toHaveBeenCalled();
    });

    it("still connects when the quarantine clear fails", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      clearQuarantine.mockRejectedValue(new Error("redis down"));

      await coordinator.connectWithLease("+5511999", {
        webhookUrl: "https://h.com",
        webhookVerifyToken: "t",
      });

      expect(handler.connect).toHaveBeenCalled();
    });

    it("releases the force-acquired lease when connect fails", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      forceAcquireLease.mockResolvedValue({ owner: "test-instance", epoch: 4 });
      handler.connect.mockRejectedValueOnce(new Error("socket failed"));

      await expect(
        coordinator.connectWithLease("+5511999", {
          webhookUrl: "https://h.com",
          webhookVerifyToken: "t",
        }),
      ).rejects.toThrow("socket failed");

      // A lease held without a socket would keep routing here until TTL.
      expect(releaseLease).toHaveBeenCalledWith("+5511999", 4);
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

  describe("#restartWithLease", () => {
    // handler.connect now takes a resolver rather than a value: it is invoked
    // after the drain, which is the point of it. Invoking it here is what the
    // real connect does.
    const spawnedWith = (handler: HandlerMock) => {
      const resolve = handler.connect.mock
        .calls[0]?.[1] as unknown as () => Record<string, unknown> | null;
      expect(typeof resolve).toBe("function");
      return resolve();
    };

    const storedMetadata = {
      webhookUrl: "https://stored.example/hook",
      webhookVerifyToken: "stored-token",
      clientName: "Stored Client",
    };

    it("rebuilds the socket from the stored metadata", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      getRedisAuthMetadata.mockResolvedValue(storedMetadata);

      const restarted = await coordinator.restartWithLease("+5511999", "stall");

      expect(restarted).toBe("restarted");
      expect(forceAcquireLease).toHaveBeenCalledWith("+5511999");
      expect(spawnedWith(handler)).toEqual({
        ...storedMetadata,
        isReconnect: true,
        leaseEpoch: 1,
        forceRestart: true,
      });
    });

    // The lease fences other instances and nothing else. A POST /connections
    // already running on THIS instance force-acquired an OLDER epoch, so the
    // guard below does not veto this restart -- and its updateOptions writes the
    // new webhook config into the live connection first, Redis after. Rebuilding
    // from the snapshot read before that would hand the replacement the
    // pre-update copy, and persistMetadata would write it back over the
    // reconfiguration.
    it("rebuilds from the live connection's options, not a superseded snapshot", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      getRedisAuthMetadata.mockResolvedValue(storedMetadata);
      // The reconfiguration lands in the window this restart spends on Redis.
      clearQuarantine.mockImplementation(async () => {
        handler.connections.add("+5511999");
        handler.liveOptions.set("+5511999", {
          webhookUrl: "https://reconfigured.example/hook",
          webhookVerifyToken: "new-token",
          clientName: "Stored Client",
        });
      });

      const restarted = await coordinator.restartWithLease("+5511999");

      expect(restarted).toBe("restarted");
      expect(spawnedWith(handler)).toEqual({
        webhookUrl: "https://reconfigured.example/hook",
        webhookVerifyToken: "new-token",
        clientName: "Stored Client",
        isReconnect: true,
        leaseEpoch: 1,
        forceRestart: true,
      });
    });

    // The snapshot the restart takes before calling connect is not the last word:
    // connect drains the per-phone slot first, and an explicit operation holding
    // it can reconfigure the live connection in that window. Since it acquired an
    // OLDER epoch, the lease guard does not veto this restart either -- so the
    // options have to be read again on the other side of the drain.
    it("re-reads the live options after the drain, not only before it", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      getRedisAuthMetadata.mockResolvedValue(storedMetadata);
      handler.connections.add("+5511999");
      handler.liveOptions.set("+5511999", {
        webhookUrl: "https://before-drain.example/hook",
        webhookVerifyToken: "old-token",
      });

      await coordinator.restartWithLease("+5511999");

      // The reconfiguration lands while this restart is parked on the slot.
      handler.liveOptions.set("+5511999", {
        webhookUrl: "https://after-drain.example/hook",
        webhookVerifyToken: "new-token",
      });

      expect(spawnedWith(handler)).toEqual({
        webhookUrl: "https://after-drain.example/hook",
        webhookVerifyToken: "new-token",
        isReconnect: true,
        leaseEpoch: 1,
        forceRestart: true,
      });
    });

    // The checks above ran before this restart queued behind the handler's per-phone
    // lock. A DELETE holding that lock clears the auth state and takes its own lease on
    // the way in, so proceeding on the metadata read earlier would create fresh unpaired
    // credentials and answer 202 for the phone the operator just removed.
    it("stops before the socket is rebuilt when another operation took the lease", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      getRedisAuthMetadata.mockResolvedValue(storedMetadata);

      await coordinator.restartWithLease("+5511999", "stall");

      expect(spawnedWith(handler)).not.toBeNull();

      // Whatever ran while we were parked force-acquired its own lease.
      (
        coordinator as unknown as { heldLeaseEpochs: Map<string, number> }
      ).heldLeaseEpochs.set("+5511999", 2);
      expect(spawnedWith(handler)).toBeNull();
    });

    // heldLeaseEpochs stops describing THIS operation the moment a concurrent explicit
    // one force-acquires its own. Unwinding by the current value would hand away that
    // operation's lease and leave its live socket unowned, free for any claim loop to
    // take; stamping our older epoch into its connection would leave every webhook it
    // sends discarded by the client as stale.
    it("releases only the epoch it acquired when it unwinds", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      getRedisAuthMetadata.mockImplementation((async () => {
        // Another explicit operation took over while we were reading.
        (
          coordinator as unknown as { heldLeaseEpochs: Map<string, number> }
        ).heldLeaseEpochs.set("+5511999", 2);
        return null;
      }) as typeof redisAuthState.getRedisAuthMetadata);

      const restarted = await coordinator.restartWithLease("+5511999");

      expect(restarted).toBe("not-found");
      // Nothing is given back and nothing is corrected: the lease is not ours to
      // unwind, and its owner's socket already carries its own epoch.
      expect(releaseLease).not.toHaveBeenCalled();
      expect(
        (
          coordinator as unknown as { heldLeaseEpochs: Map<string, number> }
        ).heldLeaseEpochs.get("+5511999"),
      ).toBe(2);
    });

    // An unpaired QR flow in progress is exactly what gets here, and it has a live
    // socket. Releasing the lease we just force-acquired would leave that socket
    // running unowned: the proxy stops routing to it and the next claim cycle
    // builds a competing socket on the same identity.
    it("keeps the lease when a live socket is still serving the phone", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      handler.connections.add("+5511999");
      isRedisAuthStatePaired.mockResolvedValue(false);
      getRedisAuthMetadata.mockResolvedValue(storedMetadata);

      const restarted = await coordinator.restartWithLease("+5511999");

      expect(restarted).toBe("not-found");
      expect(releaseLease).not.toHaveBeenCalled();
      // And the socket is told which epoch owns it now, or its webhooks are
      // discarded by the client as stale.
      expect(handler.updateLeaseEpoch).toHaveBeenCalledWith("+5511999", 1);
    });

    // A Redis blip while inspecting the session must not strand a socket that is
    // still serving: abandoning the lease stops the renewals under a live
    // connection, which is the one outcome an inspection failure has no business
    // causing.
    it("keeps the lease when the inspection itself fails under a live socket", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      handler.connections.add("+5511999");
      getRedisAuthMetadata.mockRejectedValue(new Error("redis down"));

      await expect(coordinator.restartWithLease("+5511999")).rejects.toThrow(
        "redis down",
      );

      expect(releaseLease).not.toHaveBeenCalled();
      expect(handler.updateLeaseEpoch).toHaveBeenCalledWith("+5511999", 1);
    });

    // Same rule, the other outcome: with a live socket under a lease that is no
    // longer ours, the correction we would apply belongs to the newer operation and
    // would stamp its webhooks with our older epoch.
    it("leaves a newer operation's connection untouched when unwinding", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      handler.connections.add("+5511999");
      isRedisAuthStatePaired.mockResolvedValue(false);
      getRedisAuthMetadata.mockImplementation((async () => {
        (
          coordinator as unknown as { heldLeaseEpochs: Map<string, number> }
        ).heldLeaseEpochs.set("+5511999", 2);
        return storedMetadata;
      }) as typeof redisAuthState.getRedisAuthMetadata);

      const restarted = await coordinator.restartWithLease("+5511999");

      expect(restarted).toBe("not-found");
      expect(handler.updateLeaseEpoch).not.toHaveBeenCalled();
      expect(releaseLease).not.toHaveBeenCalled();
    });

    // A veto after the drain means nothing was rebuilt. Reporting it as success
    // hands the client a 202 for a session that was deleted while it queued.
    it("reports false when the guarded connect was skipped", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      getRedisAuthMetadata.mockResolvedValue(storedMetadata);
      handler.connect.mockImplementation(async () => false);

      const restarted = await coordinator.restartWithLease("+5511999");

      // Not "not-found": the phone usually still has a perfectly good session,
      // and 404 would send the caller off to re-pair what somebody else rebuilt.
      expect(restarted).toBe("superseded");
    });

    // Taking options from the request would let a restart overwrite good
    // webhook config with whatever the caller happened to send, which is why
    // the route has no connection-options body at all.
    it("takes no connection options from the caller", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      getRedisAuthMetadata.mockResolvedValue(storedMetadata);

      await coordinator.restartWithLease("+5511999");

      expect(spawnedWith(handler)).toMatchObject({
        webhookUrl: storedMetadata.webhookUrl,
        webhookVerifyToken: storedMetadata.webhookVerifyToken,
      });
    });

    // The lease is taken BEFORE the session is inspected, and given back when there
    // turns out to be nothing to restart. Reading first would let a restart racing a
    // logout or an options update rebuild from state the previous owner was still
    // entitled to change; holding the lease afterwards would route 421s here until
    // the TTL expires, for a phone this instance just declined to serve.
    it("reports false when there is no stored session, releasing the lease it took", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      getRedisAuthMetadata.mockResolvedValue(null);

      const restarted = await coordinator.restartWithLease("+5511999");

      expect(restarted).toBe("not-found");
      expect(forceAcquireLease).toHaveBeenCalled();
      expect(releaseLease).toHaveBeenCalledWith("+5511999", 1);
      expect(handler.connect).not.toHaveBeenCalled();
    });

    // Metadata is not a session: useRedisAuthState writes it when the socket
    // starts, so an unscanned QR flow satisfies the metadata check. Restarting
    // that would answer 202 and spawn another unpaired QR socket, which is the
    // opposite of what a route promising "no QR, no re-pairing" should do.
    it("reports false for a session that never finished pairing", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      getRedisAuthMetadata.mockResolvedValue(storedMetadata);
      isRedisAuthStatePaired.mockResolvedValue(false);

      const restarted = await coordinator.restartWithLease("+5511999");

      expect(restarted).toBe("not-found");
      expect(forceAcquireLease).toHaveBeenCalled();
      expect(releaseLease).toHaveBeenCalledWith("+5511999", 1);
      expect(handler.connect).not.toHaveBeenCalled();
    });

    // The ordering, not just the outcome: until the lease moves, the previous owner
    // may still rewrite the metadata (an options update) or delete the auth state (a
    // logout). Reading first means a restart racing either one rebuilds from
    // configuration that has since been superseded.
    it("takes the lease before reading the stored session", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      let leaseHeldAtRead = false;
      getRedisAuthMetadata.mockImplementation((async () => {
        leaseHeldAtRead = forceAcquireLease.mock.calls.length > 0;
        return storedMetadata;
      }) as typeof redisAuthState.getRedisAuthMetadata);

      await coordinator.restartWithLease("+5511999");

      expect(leaseHeldAtRead).toBe(true);
    });

    it("clears quarantine — an operator asking for the phone wins now", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      getRedisAuthMetadata.mockResolvedValue(storedMetadata);

      await coordinator.restartWithLease("+5511999");

      expect(clearQuarantine).toHaveBeenCalledWith("+5511999");
    });
  });

  describe("#importSessionWithLease", () => {
    const creds = { me: { id: "5511999:1@s.whatsapp.net" } } as never;
    const candidates = [
      { private: "np0", public: "nb0" },
      { private: "np1", public: "nb1" },
    ];
    const options = { webhookUrl: "https://h.com", webhookVerifyToken: "t" };

    it("acquires the lease, seeds the imported session, then connects", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);

      await coordinator.importSessionWithLease(
        "+5511999",
        creds,
        candidates,
        0,
        options,
      );

      expect(forceAcquireLease).toHaveBeenCalledWith("+5511999");
      expect(seedImportedSession).toHaveBeenCalledWith(
        "+5511999",
        creds,
        candidates,
        0,
      );
      expect(handler.connect).toHaveBeenCalledWith("+5511999", {
        ...options,
        leaseEpoch: 1,
        forceRestart: true,
      });
    });

    it("clears quarantine — a fresh import must not inherit old strikes", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);

      await coordinator.importSessionWithLease(
        "+5511999",
        creds,
        candidates,
        0,
        options,
      );

      expect(clearQuarantine).toHaveBeenCalledWith("+5511999");
      expect(handler.connect).toHaveBeenCalled();
    });

    it("seeds only after acquiring the lease (fence needs ownership)", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      const order: string[] = [];
      forceAcquireLease.mockImplementation(async () => {
        order.push("acquire");
        return { owner: "test-instance", epoch: 1 };
      });
      seedImportedSession.mockImplementation(async () => {
        order.push("seed");
        return true;
      });

      await coordinator.importSessionWithLease(
        "+5511999",
        creds,
        candidates,
        0,
        options,
      );

      expect(order).toEqual(["acquire", "seed"]);
    });

    it("releases the lease and does not connect when the seed is fenced off", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      forceAcquireLease.mockResolvedValue({ owner: "test-instance", epoch: 9 });
      seedImportedSession.mockResolvedValue(false);

      await expect(
        coordinator.importSessionWithLease(
          "+5511999",
          creds,
          candidates,
          0,
          options,
        ),
      ).rejects.toThrow(/seed/i);

      expect(handler.connect).not.toHaveBeenCalled();
      expect(releaseLease).toHaveBeenCalledWith("+5511999", 9);
    });

    it("releases the lease when connect throws after a successful seed", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      forceAcquireLease.mockResolvedValue({ owner: "test-instance", epoch: 4 });
      handler.connect.mockRejectedValueOnce(new Error("connect boom"));

      await expect(
        coordinator.importSessionWithLease(
          "+5511999",
          creds,
          candidates,
          0,
          options,
        ),
      ).rejects.toThrow("connect boom");

      // The release-on-failure rollback holds even after the lease AND the seed
      // both succeed, not just on the pre-connect fencing paths.
      expect(seedImportedSession).toHaveBeenCalled();
      expect(releaseLease).toHaveBeenCalledWith("+5511999", 4);
    });

    it("refuses to steal a live instance's lease in worker role", async () => {
      config.cluster.role = "worker";
      try {
        const handler = makeHandlerMock();
        const coordinator = makeCoordinator(handler);
        getLease.mockResolvedValue({ owner: "peer-instance", epoch: 3 });
        isInstanceAlive.mockResolvedValue(true);

        await expect(
          coordinator.importSessionWithLease(
            "+5511999",
            creds,
            candidates,
            0,
            options,
          ),
        ).rejects.toThrow(BaileysConnectionOwnedElsewhereError);

        expect(forceAcquireLease).not.toHaveBeenCalled();
        expect(seedImportedSession).not.toHaveBeenCalled();
      } finally {
        config.cluster.role = "standalone";
      }
    });
  });

  describe("#logoutWithLease", () => {
    it("logs out and releases the lease under the epoch acquired at connect", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);
      forceAcquireLease.mockResolvedValue({ owner: "test-instance", epoch: 8 });
      await coordinator.connectWithLease("+5511999", {
        webhookUrl: "https://h.com",
        webhookVerifyToken: "t",
      });

      await coordinator.logoutWithLease("+5511999");

      expect(handler.logout).toHaveBeenCalledWith("+5511999");
      expect(releaseLease).toHaveBeenCalledWith("+5511999", 8);
    });

    it("releases under the epoch of the takeover the logout itself acquired", async () => {
      const handler = makeHandlerMock();
      handler.connections.add("+5511999");
      const coordinator = makeCoordinator(handler);
      forceAcquireLease.mockResolvedValue({ owner: "test-instance", epoch: 5 });

      await coordinator.logoutWithLease("+5511999");

      expect(handler.logout).toHaveBeenCalledWith("+5511999");
      expect(releaseLease).toHaveBeenCalledWith("+5511999", 5);
    });

    it("force-takes a foreign lease in standalone — an explicit DELETE is authoritative", async () => {
      const handler = makeHandlerMock();
      handler.connections.add("+5511999");
      const coordinator = makeCoordinator(handler);
      getLease.mockResolvedValue({ owner: "other-instance", epoch: 5 });
      forceAcquireLease.mockResolvedValue({ owner: "test-instance", epoch: 6 });

      await coordinator.logoutWithLease("+5511999");

      expect(forceAcquireLease).toHaveBeenCalledWith("+5511999");
      expect(releaseLease).toHaveBeenCalledWith("+5511999", 6);
    });

    it("refuses to steal a live peer's lease in worker role", async () => {
      config.cluster.role = "worker";
      try {
        const handler = makeHandlerMock();
        const coordinator = makeCoordinator(handler);
        getLease.mockResolvedValue({ owner: "peer-instance", epoch: 3 });
        isInstanceAlive.mockResolvedValue(true);

        await expect(coordinator.logoutWithLease("+5511999")).rejects.toThrow(
          BaileysConnectionOwnedElsewhereError,
        );
        expect(handler.logout).not.toHaveBeenCalled();
      } finally {
        config.cluster.role = "standalone";
      }
    });

    it("clears the persisted auth state on an offline logout (no live socket)", async () => {
      const handler = makeHandlerMock();
      handler.logout.mockRejectedValueOnce(new BaileysNotConnectedError());
      const coordinator = makeCoordinator(handler);

      await coordinator.logoutWithLease("+5511999");

      expect(clearRedisAuthState).toHaveBeenCalledWith("+5511999");
      expect(clearQuarantine).toHaveBeenCalledWith("+5511999");
      expect(releaseLease).toHaveBeenCalled();
    });

    // The send-stall backoff is keyed by phone number and outlives the session
    // by up to 24h. Left behind, a re-paired number inherits the discarded
    // session's backoff and has its stall watchdog suppressed.
    it("clears the send-stall backoff along with the rest of the strike state", async () => {
      const handler = makeHandlerMock();
      const coordinator = makeCoordinator(handler);

      await coordinator.logoutWithLease("+5511999");

      expect(clearSendStall).toHaveBeenCalledWith("+5511999");
    });

    it("throws when the offline clear is fenced off", async () => {
      const handler = makeHandlerMock();
      handler.logout.mockRejectedValueOnce(new BaileysNotConnectedError());
      clearRedisAuthState.mockResolvedValueOnce(false);
      const coordinator = makeCoordinator(handler);

      await expect(coordinator.logoutWithLease("+5511999")).rejects.toThrow(
        "fenced off",
      );
      expect(releaseLease).toHaveBeenCalled();
    });

    it("does not touch the persisted auth state on a normal online logout", async () => {
      const handler = makeHandlerMock();
      handler.connections.add("+5511999");
      const coordinator = makeCoordinator(handler);

      await coordinator.logoutWithLease("+5511999");

      expect(clearRedisAuthState).not.toHaveBeenCalled();
    });

    it("releases the takeover lease even when logout throws a non-offline error", async () => {
      const handler = makeHandlerMock();
      handler.logout.mockRejectedValueOnce(new Error("socket exploded"));
      const coordinator = makeCoordinator(handler);
      forceAcquireLease.mockResolvedValue({ owner: "test-instance", epoch: 5 });

      await expect(coordinator.logoutWithLease("+5511999")).rejects.toThrow(
        "socket exploded",
      );
      // A plain Error is NOT the offline path — no destructive clear.
      expect(clearRedisAuthState).not.toHaveBeenCalled();
      expect(releaseLease).toHaveBeenCalledWith("+5511999", 5);
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
      getLease.mockImplementation(async () => ({
        owner: "test-instance",
        epoch: 1,
      }));
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
