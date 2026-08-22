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
export async function recordRestart(phoneNumber: string): Promise<{
  state: SendStallState;
  previous: SendStallState | null;
  previousTtlMs: number | null;
}> {
  const key = clusterKeys.sendStall(phoneNumber);
  const previous = await readState(key);
  // Read BEFORE the write below resets it. A cancelled restart has to put back
  // the expiry it found as well as the value: restoring with a fresh 24h would
  // give an old restart history another full day to escalate from, on the
  // strength of a restart that never happened.
  const previousTtlMs = previous === null ? null : await readTtlMs(key);
  const restarts = (previous?.restarts ?? 0) + 1;
  const state: SendStallState = {
    restarts,
    nextRestartAllowedAt: Date.now() + backoffMs(restarts),
  };
  await redis.set(key, JSON.stringify(state), {
    expiration: { type: "PX", value: SEND_STALL_TTL_MS },
  });
  // `previous` travels back so a caller whose restart is cancelled after the
  // fact can undo exactly its own increment. Deleting instead would hand the
  // phone a clean slate it did not earn: the history in here is per phone and
  // lives 24h, so an earlier genuine strike would go with it.
  return { state, previous, previousTtlMs };
}

// -1 means the key has no expiry and -2 that it is gone; neither is a duration
// worth restoring, and both fall back to a full TTL rather than writing a key
// that never expires.
async function readTtlMs(key: string): Promise<number | null> {
  try {
    const ttl = await redis.pTTL(key);
    return typeof ttl === "number" && ttl > 0 ? ttl : null;
  } catch {
    return null;
  }
}

// Undoes one recordRestart. Same read-modify-write assumption as everything else
// in this file: the only writer is the instance that owns the stalled socket.
export async function restoreState(
  phoneNumber: string,
  previous: SendStallState | null,
  ttlMs: number | null = null,
): Promise<void> {
  const key = clusterKeys.sendStall(phoneNumber);
  if (previous === null) {
    await redis.del(key);
    return;
  }
  await redis.set(key, JSON.stringify(previous), {
    // The expiry the key had when recordRestart found it, not a fresh one. The
    // window is per phone and slides with each GENUINE restart; a restart that
    // was called off must not slide it, or an old history keeps escalating the
    // backoff for up to a day longer than it earned.
    expiration: { type: "PX", value: ttlMs ?? SEND_STALL_TTL_MS },
  });
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
