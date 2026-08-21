import { clusterKeys } from "@/cluster/keys";
import redis from "@/lib/redis";

// Rate-limits the send-stall watchdog's socket restarts per phone. A phone that
// stalls again minutes after a restart is not being cured by restarting, so the
// backoff escalates towards "give up and let the operator see it" instead of
// looping.
//
// This is a sibling of quarantineStore, not a reuse of it, for two reasons.
// Semantics are opposite: quarantine means "do not CLAIM this phone" and is
// read only by background claims, so feeding stall strikes into it would make a
// stalled-but-healthy phone unclaimable right after a failover — when moving to
// another instance is precisely the cure. And the mechanism would not even
// work: clearQuarantine runs on every healthy `open`, which a stall restart
// produces seconds later, so the strike would be wiped before it ever mattered.
//
// The key is per-phone and cluster-wide, which here is deliberate: a phone that
// stalls on instance A should not be hammered with restarts after it migrates
// to instance B.
export interface SendStallState {
  restarts: number;
  nextRestartAllowedAt: number;
}

// Kept as module constants rather than env vars, matching
// CONNECTION_REPLACED_LOOP_* in connection.ts: these are the shape of a
// heuristic, not something an operator tunes per deployment.
const SEND_STALL_BACKOFF_BASE_MS = 5 * 60 * 1000;
const SEND_STALL_BACKOFF_MAX_MS = 60 * 60 * 1000;
// Shorter than quarantine's 7 days: 13 occurrences since May is sparse history,
// so this only needs to catch flapping within a day and then self-clean.
const SEND_STALL_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BACKOFF_EXPONENT = 25;

export function backoffMs(restarts: number): number {
  const exponent = Math.min(Math.max(restarts - 1, 0), MAX_BACKOFF_EXPONENT);
  return Math.min(
    SEND_STALL_BACKOFF_BASE_MS * 2 ** exponent,
    SEND_STALL_BACKOFF_MAX_MS,
  );
}

async function readState(key: string): Promise<SendStallState | null> {
  const raw = await redis.get(key);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as SendStallState;
  } catch {
    return null;
  }
}

// Whether a restart may run now. The FIRST restart for a phone is always
// allowed — the backoff only gates repeats inside the window, because the whole
// point is to recover fast the first time.
export async function canRestart(phoneNumber: string): Promise<boolean> {
  const state = await readState(clusterKeys.sendStall(phoneNumber));
  return !state || state.nextRestartAllowedAt <= Date.now();
}

// Plain read-modify-write, no CAS, mirroring quarantineStore: the only writer
// is the instance that owns the stalled socket.
export async function recordRestart(
  phoneNumber: string,
): Promise<SendStallState> {
  const key = clusterKeys.sendStall(phoneNumber);
  const previous = await readState(key);
  const restarts = (previous?.restarts ?? 0) + 1;
  const state: SendStallState = {
    restarts,
    nextRestartAllowedAt: Date.now() + backoffMs(restarts),
  };
  await redis.set(key, JSON.stringify(state), {
    expiration: { type: "PX", value: SEND_STALL_TTL_MS },
  });
  return state;
}

export async function nextRestartAllowedAt(
  phoneNumber: string,
): Promise<number | null> {
  const state = await readState(clusterKeys.sendStall(phoneNumber));
  return state?.nextRestartAllowedAt ?? null;
}

export async function clearSendStall(phoneNumber: string): Promise<void> {
  await redis.del(clusterKeys.sendStall(phoneNumber));
}
