import { instanceId } from "@/cluster/identity";
import { clusterKeys } from "@/cluster/keys";
import config from "@/config";
import redis from "@/lib/redis";

// A lease marks which instance currently owns a phone number's WhatsApp
// socket. Stored as a JSON string under a TTL'd key; the owner renews it
// periodically and self-fences (closes the socket) when renewal reports the
// lease now belongs to someone else. The epoch strictly increases across
// successive owners, so any consumer can order ownership transitions even
// when events arrive late.
export interface Lease {
  owner: string;
  epoch: number;
}

// Renewal outcomes are deliberately distinct from transport errors:
// - "renewed": still the owner, TTL extended.
// - "lost": the key exists but belongs to another instance — the caller must
//   fence immediately (discard the socket, never write auth state again).
// - "missing": the key vanished (TTL elapsed while we were degraded, or a
//   Redis failover dropped it). The caller should attempt an immediate
//   re-acquire: the previous owner nearly always wins that race because
//   competitors only claim keys they observe as unleased on their next scan.
// Redis transport errors are NOT mapped to these — they throw, and the caller
// must treat them as "unknown", keeping the socket alive (see coordinator).
export type RenewResult = "renewed" | "lost" | "missing";

// Compare-owner renewal. Plain GET + PEXPIRE would race: between the two
// commands the lease can expire and be re-acquired, and we would extend (and
// believe we own) somebody else's lease.
const RENEW_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return -1 end
local lease = cjson.decode(raw)
if lease.owner ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`;

// Compare-and-delete so a late release (e.g. a slow shutdown) cannot drop a
// lease that has already moved on. Owner alone is not enough: the same
// instance can re-acquire the phone (new epoch) while an older release is
// still in flight, so the epoch must match too.
const RELEASE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local lease = cjson.decode(raw)
if lease.owner ~= ARGV[1] then return 0 end
if tostring(lease.epoch) ~= ARGV[2] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`;

function leaseTtl() {
  return config.cluster.leaseTtlMs;
}

// Best-effort claim: wins only if the phone is currently unleased. The epoch
// counter is bumped before the SET — a losing claim burns an epoch, which is
// harmless (epochs only need to be monotonic, not dense).
export async function acquireLease(phoneNumber: string): Promise<Lease | null> {
  const epoch = await redis.incr(clusterKeys.leaseEpoch(phoneNumber));
  const lease: Lease = { owner: instanceId, epoch };
  const result = await redis.set(
    clusterKeys.lease(phoneNumber),
    JSON.stringify(lease),
    {
      condition: "NX",
      expiration: { type: "PX", value: leaseTtl() },
    },
  );
  return result ? lease : null;
}

// Unconditional takeover. Reserved for explicit user intent (POST
// /connections) and for claiming from an owner that is verifiably dead —
// never for background claims, which must go through acquireLease.
export async function forceAcquireLease(phoneNumber: string): Promise<Lease> {
  const epoch = await redis.incr(clusterKeys.leaseEpoch(phoneNumber));
  const lease: Lease = { owner: instanceId, epoch };
  await redis.set(clusterKeys.lease(phoneNumber), JSON.stringify(lease), {
    expiration: { type: "PX", value: leaseTtl() },
  });
  return lease;
}

export async function renewLease(phoneNumber: string): Promise<RenewResult> {
  const result = await redis.eval(RENEW_SCRIPT, {
    keys: [clusterKeys.lease(phoneNumber)],
    arguments: [instanceId, String(leaseTtl())],
  });
  if (result === 1) {
    return "renewed";
  }
  if (result === -1) {
    return "missing";
  }
  return "lost";
}

export async function releaseLease(
  phoneNumber: string,
  expectedEpoch: number,
): Promise<boolean> {
  const result = await redis.eval(RELEASE_SCRIPT, {
    keys: [clusterKeys.lease(phoneNumber)],
    arguments: [instanceId, String(expectedEpoch)],
  });
  return result === 1;
}

export async function getLease(phoneNumber: string): Promise<Lease | null> {
  const raw = await redis.get(clusterKeys.lease(phoneNumber));
  return raw ? (JSON.parse(raw) as Lease) : null;
}

export async function setReleaseCooldown(phoneNumber: string): Promise<void> {
  await redis.set(clusterKeys.cooldown(phoneNumber), instanceId, {
    expiration: { type: "PX", value: config.cluster.releaseCooldownMs },
  });
}

// Only the instance that released a phone is throttled from re-claiming it —
// everyone else may claim immediately. This is the anti-ping-pong guard for
// rebalance releases, not a global lock.
export async function isOnOwnReleaseCooldown(
  phoneNumber: string,
): Promise<boolean> {
  const value = await redis.get(clusterKeys.cooldown(phoneNumber));
  return value === instanceId;
}

// Directed handoff tombstone: a rebalance release names its intended next
// owner so the releaser's own claim loop (the lowest-latency claimant) does
// not just take the phone right back. When the tombstone expires the phone
// falls back to an open claim — nobody is left waiting on a dead target.
export async function setHandoffTarget(
  phoneNumber: string,
  targetInstanceId: string,
): Promise<void> {
  await redis.set(clusterKeys.handoff(phoneNumber), targetInstanceId, {
    expiration: { type: "PX", value: config.cluster.leaseTtlMs },
  });
}

export async function getHandoffTarget(
  phoneNumber: string,
): Promise<string | null> {
  return await redis.get(clusterKeys.handoff(phoneNumber));
}
