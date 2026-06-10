import type { BaileysConnectionsHandler } from "@/baileys/connectionsHandler";
import {
  getRedisSavedAuthStateIds,
  isRedisAuthStatePaired,
} from "@/baileys/redisAuthState";
import type { BaileysConnectionOptions } from "@/baileys/types";
import { instanceId } from "@/cluster/identity";
import * as registry from "@/cluster/instanceRegistry";
import * as leaseStore from "@/cluster/leaseStore";
import config from "@/config";
import { asyncSleep } from "@/helpers/asyncSleep";
import { errorToString } from "@/helpers/errorToString";
import logger from "@/lib/logger";
import redis from "@/lib/redis";

type StoredMetadata = Omit<
  BaileysConnectionOptions,
  "phoneNumber" | "onConnectionClose"
>;

// A POST /connections reached a worker while another LIVE instance owns the
// phone. The controller surfaces this as 409 + x-baileys-owner so the proxy
// can re-route the request to the owner instead of force-stealing the
// identity out from under a healthy socket.
export class BaileysConnectionOwnedElsewhereError extends Error {
  readonly ownerInstanceId: string;

  constructor(ownerInstanceId: string) {
    super(`Connection is owned by live instance ${ownerInstanceId}`);
    this.ownerInstanceId = ownerInstanceId;
  }
}

export interface CoordinatorOptions {
  claimIntervalMs: number;
  claimJitterMs: number;
  leaseRenewIntervalMs: number;
  heartbeatIntervalMs: number;
  reconnectConcurrency: number;
  unclaimedGraceMs: number;
  shutdownTimeoutMs: number;
}

// Owns the distributed side of connection lifecycle: which phone numbers this
// instance is allowed to hold a socket for. The in-memory serialization of
// connect/logout stays in BaileysConnectionsHandler (inFlightOps); this class
// arbitrates BETWEEN instances via Redis leases.
//
// Loops (all started by start(), stopped by shutdown()):
// - claim loop: scans saved auth states and claims unleased phones, capped at
//   a fair share of the cluster so a cold-booting instance doesn't steal
//   everything before its peers come up.
// - renewal loop: extends the leases of locally-held connections and
//   self-fences when a lease turns out to be owned elsewhere.
// - heartbeat loop: registers this instance (address, load, draining) so
//   peers can compute fair share and the proxy can route.
export class ClusterCoordinator {
  private handler: BaileysConnectionsHandler;
  private options: CoordinatorOptions;
  private running = false;
  private draining = false;
  // Set when Redis is unreachable; pauses claims (our view of the cluster is
  // stale) without fencing the sockets we already hold.
  private redisDegraded = false;
  private claimTimer: ReturnType<typeof setTimeout> | null = null;
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  // Monotonic timestamps of when each phone was first observed without a
  // lease. Drives the orphan override: the fair-share cap must never leave a
  // phone unowned forever (e.g. rounding when phones % instances != 0).
  private firstSeenUnleasedAt = new Map<string, number>();
  // Epoch of each lease this instance currently holds. Releases are
  // compare-and-delete on (owner, epoch), so a stale release can never drop a
  // lease the same instance has since re-acquired under a newer epoch.
  private heldLeaseEpochs = new Map<string, number>();

  constructor(
    handler: BaileysConnectionsHandler,
    options?: Partial<CoordinatorOptions>,
  ) {
    this.handler = handler;
    this.options = {
      claimIntervalMs: config.cluster.claimIntervalMs,
      claimJitterMs: config.cluster.claimJitterMs,
      leaseRenewIntervalMs: config.cluster.leaseRenewIntervalMs,
      heartbeatIntervalMs: config.cluster.heartbeatIntervalMs,
      reconnectConcurrency: config.cluster.reconnectConcurrency,
      unclaimedGraceMs: config.cluster.unclaimedGraceMs,
      shutdownTimeoutMs: config.cluster.shutdownTimeoutMs,
      ...options,
    };
  }

  /**
   * Monotonic clock for lease safety windows. `performance.now()` is
   * high-resolution and immune to NTP steps; `Date.now()` is off-limits here
   * because a wall-clock jump would stretch or shrink grace periods and
   * deadlines, breaking the lease timing guarantees.
   */
  private now() {
    return performance.now();
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    void this.runHeartbeat();
    this.scheduleHeartbeat();
    this.scheduleRenew();
    // Random initial delay de-synchronizes cold-boot claims across replicas
    // so SET NX splits the phones instead of the fastest booter taking all.
    const initialDelay = Math.floor(Math.random() * this.options.claimJitterMs);
    this.claimTimer = setTimeout(() => {
      void this.claimTick();
    }, initialDelay);
  }

  private scheduleClaim() {
    if (!this.running) {
      return;
    }
    const jitter = Math.floor(Math.random() * this.options.claimJitterMs);
    this.claimTimer = setTimeout(() => {
      void this.claimTick();
    }, this.options.claimIntervalMs + jitter);
  }

  private async claimTick() {
    try {
      await this.runClaimCycle();
    } catch (error) {
      logger.error(
        "[coordinator] claim cycle failed: %s",
        errorToString(error),
      );
    }
    this.scheduleClaim();
  }

  private scheduleRenew() {
    if (!this.running) {
      return;
    }
    this.renewTimer = setTimeout(async () => {
      try {
        await this.runRenewCycle();
      } catch (error) {
        logger.error(
          "[coordinator] renew cycle failed: %s",
          errorToString(error),
        );
      }
      this.scheduleRenew();
    }, this.options.leaseRenewIntervalMs);
  }

  private scheduleHeartbeat() {
    if (!this.running) {
      return;
    }
    this.heartbeatTimer = setTimeout(async () => {
      await this.runHeartbeat();
      this.scheduleHeartbeat();
    }, this.options.heartbeatIntervalMs);
  }

  async runHeartbeat() {
    try {
      await registry.heartbeat({
        connectionCount: this.handler.size,
        draining: this.draining,
      });
    } catch (error) {
      logger.warn("[coordinator] heartbeat failed: %s", errorToString(error));
    }
  }

  // One pass over the saved auth states: claim what is unleased, bounded by
  // fair share, then reconnect the claims with limited concurrency.
  async runClaimCycle() {
    if (this.draining || this.redisDegraded) {
      return;
    }

    const saved = await getRedisSavedAuthStateIds<StoredMetadata>();
    const savedIds = new Set(saved.map(({ id }) => id));
    for (const phone of this.firstSeenUnleasedAt.keys()) {
      if (!savedIds.has(phone) || this.handler.hasConnection(phone)) {
        this.firstSeenUnleasedAt.delete(phone);
      }
    }
    if (saved.length === 0) {
      return;
    }

    let instances: registry.InstanceInfo[];
    try {
      instances = await registry.listLiveInstances();
    } catch (error) {
      // A failed registry read means our cluster view is stale. Treating it
      // as "no peers" would let this node ignore the fair-share cap and grab
      // everything — skip the cycle instead and retry on the next tick.
      logger.warn(
        "[coordinator] instance registry unavailable, skipping claim cycle: %s",
        errorToString(error),
      );
      return;
    }
    const liveCount = Math.max(
      instances.filter((instance) => !instance.draining).length,
      1,
    );
    const fairShare = Math.ceil(saved.length / liveCount);
    const now = this.now();

    const candidates = shuffle(
      saved.filter(({ id }) => !this.handler.hasConnection(id)),
    );
    const claimed: Array<{ id: string; metadata: StoredMetadata }> = [];

    for (const { id, metadata } of candidates) {
      // SIGTERM can land mid-scan; stop acquiring work the shutdown handoff
      // will never see (its phone snapshot is taken from live connections).
      if (this.draining) {
        break;
      }
      try {
        const lease = await leaseStore.getLease(id);
        if (lease) {
          this.firstSeenUnleasedAt.delete(id);
          continue;
        }
        if (!this.firstSeenUnleasedAt.has(id)) {
          this.firstSeenUnleasedAt.set(id, now);
        }
        const firstSeen = this.firstSeenUnleasedAt.get(id) ?? now;
        const orphaned = now - firstSeen >= this.options.unclaimedGraceMs;
        if (this.handler.size + claimed.length >= fairShare && !orphaned) {
          continue;
        }
        if (await leaseStore.isOnOwnReleaseCooldown(id)) {
          continue;
        }
        // A phone that never finished pairing has no session to resume; a QR
        // flow must be restarted by an explicit POST /connections, on
        // whichever instance receives it.
        if (!(await isRedisAuthStatePaired(id))) {
          continue;
        }
        const acquired = await leaseStore.acquireLease(id);
        if (!acquired) {
          continue;
        }
        this.heldLeaseEpochs.set(id, acquired.epoch);
        this.firstSeenUnleasedAt.delete(id);
        void registry.publishOwnershipChanged(id);
        claimed.push({ id, metadata });
      } catch (error) {
        logger.warn(
          "[coordinator] claim check failed for %s: %s",
          id,
          errorToString(error),
        );
      }
    }

    if (claimed.length === 0) {
      return;
    }

    if (this.draining) {
      // Leases acquired in this scan never reached the handler, so the
      // shutdown handoff cannot release them — do it here for the survivors.
      for (const { id } of claimed) {
        await this.releaseHeldLease(id).catch(() => {});
      }
      return;
    }

    logger.info(
      "[coordinator] claimed %d connection(s): %o",
      claimed.length,
      claimed.map(({ id }) => id),
    );

    const { reconnectConcurrency } = this.options;
    for (let i = 0; i < claimed.length; i += reconnectConcurrency) {
      const chunk = claimed.slice(i, i + reconnectConcurrency);
      await Promise.allSettled(
        chunk.map(async ({ id, metadata }) => {
          await asyncSleep(Math.floor(Math.random() * 100));
          if (this.draining) {
            await this.releaseHeldLease(id).catch(() => {});
            return;
          }
          try {
            await this.handler.connect(id, {
              isReconnect: true,
              ...metadata,
            });
          } catch (error) {
            logger.error(
              "[coordinator] reconnect failed for %s, releasing lease: %s",
              id,
              errorToString(error),
            );
            // Don't sit on a lease we can't service — let a peer try.
            await this.releaseHeldLease(id).catch(() => {});
          }
        }),
      );
    }
  }

  async runRenewCycle() {
    const phones = this.handler.getActivePhoneNumbers();
    if (phones.length === 0) {
      // An idle worker has no renewals to clear redisDegraded with, so a
      // recovered Redis would otherwise leave claims paused forever — probe
      // directly instead.
      if (this.redisDegraded) {
        try {
          await redis.ping();
          this.redisDegraded = false;
        } catch {
          // Still unreachable; claims stay paused.
        }
      }
      return;
    }
    for (const phone of phones) {
      try {
        const result = await leaseStore.renewLease(phone);
        if (result === "renewed") {
          this.redisDegraded = false;
          continue;
        }
        if (result === "missing") {
          // The key vanished (TTL elapsed while we were degraded, or a Redis
          // failover dropped it). Re-assert immediately: competitors only
          // claim phones they have observed unleased, so the sitting owner
          // wins this race in practice — no socket churn.
          const lease = await leaseStore.acquireLease(phone);
          if (lease) {
            this.heldLeaseEpochs.set(phone, lease.epoch);
            this.redisDegraded = false;
            continue;
          }
        }
        logger.warn(
          "[coordinator] lease for %s is owned elsewhere, discarding local socket",
          phone,
        );
        this.heldLeaseEpochs.delete(phone);
        // Socket cleanup failures are not Redis failures — swallowing them
        // here keeps them out of the redisDegraded catch below, which would
        // otherwise pause claims with Redis perfectly healthy.
        await this.handler.discardConnection(phone).catch((error) => {
          logger.warn(
            "[coordinator] discard failed for %s: %s",
            phone,
            errorToString(error),
          );
        });
      } catch (error) {
        // Redis unreachable is NOT loss of ownership. If we can't reach
        // Redis, competitors most likely can't either; and if someone does
        // take over, the WhatsApp server kicks this socket with
        // conflict/replaced and the lease gate yields then. Mass self-fencing
        // here would turn a Redis blip into a self-inflicted full outage.
        this.redisDegraded = true;
        logger.warn(
          "[coordinator] lease renewal failed, keeping sockets and pausing claims: %s",
          errorToString(error),
        );
        return;
      }
    }
  }

  // Explicit user intent (POST /connections) — takes the identity over even
  // if a lease exists. In standalone this matches today's single-instance
  // semantics (the request is authoritative). In worker role, a lease held
  // by another LIVE instance is not stolen: the caller gets
  // BaileysConnectionOwnedElsewhereError and the proxy re-routes the request
  // to the owner. A dead owner's lease is force-taken immediately instead of
  // waiting for the TTL.
  async connectWithLease(
    phoneNumber: string,
    options: BaileysConnectionOptions,
  ) {
    if (config.cluster.role === "worker") {
      const lease = await leaseStore.getLease(phoneNumber);
      if (
        lease &&
        lease.owner !== instanceId &&
        (await registry.isInstanceAlive(lease.owner))
      ) {
        throw new BaileysConnectionOwnedElsewhereError(lease.owner);
      }
    }
    const acquired = await leaseStore.forceAcquireLease(phoneNumber);
    this.heldLeaseEpochs.set(phoneNumber, acquired.epoch);
    void registry.publishOwnershipChanged(phoneNumber);
    await this.handler.connect(phoneNumber, options);
  }

  get isDraining(): boolean {
    return this.draining;
  }

  async logoutWithLease(phoneNumber: string) {
    try {
      await this.handler.logout(phoneNumber);
    } finally {
      await this.releaseHeldLease(phoneNumber).catch(() => {});
      void registry.publishOwnershipChanged(phoneNumber);
    }
  }

  // Releases via compare-and-delete on the epoch we hold. Falls back to a
  // lease read when the epoch was never tracked (e.g. a logout for a phone
  // claimed before a process restart): if the lease meanwhile changed hands
  // or epochs, the scripted compare no-ops, which is the safe outcome.
  private async releaseHeldLease(phoneNumber: string) {
    let epoch = this.heldLeaseEpochs.get(phoneNumber);
    this.heldLeaseEpochs.delete(phoneNumber);
    if (epoch === undefined) {
      const lease = await leaseStore.getLease(phoneNumber);
      if (lease?.owner !== instanceId) {
        return;
      }
      epoch = lease.epoch;
    }
    await leaseStore.releaseLease(phoneNumber, epoch);
  }

  // Graceful handoff: announce draining (peers stop counting us toward fair
  // share), close each socket BEFORE releasing its lease (the next owner must
  // never overlap with a still-open socket), then give in-flight webhooks a
  // bounded window to drain.
  async shutdown() {
    if (this.draining) {
      return;
    }
    this.draining = true;
    this.running = false;
    if (this.claimTimer) {
      clearTimeout(this.claimTimer);
    }
    if (this.renewTimer) {
      clearTimeout(this.renewTimer);
    }
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
    }

    await this.runHeartbeat();

    const phones = this.handler.getActivePhoneNumbers();
    if (phones.length > 0) {
      logger.info(
        "[coordinator] releasing %d connection(s) for handoff",
        phones.length,
      );
    }
    for (const phone of phones) {
      try {
        await this.handler.discardConnection(phone);
        await this.releaseHeldLease(phone);
        void registry.publishOwnershipChanged(phone);
      } catch (error) {
        logger.warn(
          "[coordinator] handoff failed for %s: %s",
          phone,
          errorToString(error),
        );
      }
    }

    const deadline = this.now() + this.options.shutdownTimeoutMs;
    while (this.handler.inFlightWebhookCount() > 0 && this.now() < deadline) {
      await asyncSleep(250);
    }

    await registry.deregister().catch((error) => {
      logger.warn("[coordinator] deregister failed: %s", errorToString(error));
    });
  }
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
