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

function parseState(raw: string | null): SendStallState | null {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as SendStallState;
  } catch {
    return null;
  }
}

async function readState(key: string): Promise<SendStallState | null> {
  return parseState(await redis.get(key));
}

// Whether a restart may run now. The FIRST restart for a phone is always
// allowed — the backoff only gates repeats inside the window, because the whole
// point is to recover fast the first time.
export async function canRestart(phoneNumber: string): Promise<boolean> {
  const state = await readState(clusterKeys.sendStall(phoneNumber));
  return !state || state.nextRestartAllowedAt <= Date.now();
}

// Compare-and-set, not the plain read-modify-write quarantineStore uses. That
// pattern rests on "the only writer is the instance that owns the stalled
// socket", and this key has a window where two of them exist: during a lease
// handoff the old owner can still be inside an episode -- it discovers the
// handoff in the same round trip that writes this strike -- while the new owner
// starts one of its own. A lost increment costs one step of escalation; an old
// owner's rollback landing on the new owner's strike costs the whole history,
// on precisely the phone that is flapping between instances.
//
// KEYS[1]=key, ARGV=[expected ("" for absent), value, ttlMs]. Every value ever
// stored here is JSON, so "" is unambiguous as "the key must not exist".
const CAS_SCRIPT = `-- send-stall-cas
local raw = redis.call("GET", KEYS[1])
if (raw == false and ARGV[1] == "") or raw == ARGV[1] then
  redis.call("SET", KEYS[1], ARGV[2], "PX", ARGV[3])
  return 1
end
return 0`;

// The delete half of the same rule: drop the key only if it still holds what we
// wrote. KEYS[1]=key, ARGV[1]=expected.
const CAD_SCRIPT = `-- send-stall-cad
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("DEL", KEYS[1])
  return 1
end
return 0`;

// Bounded, because a retry only makes sense while the contention is real. Losing
// three in a row means another owner is writing steadily, and its strikes are
// doing the job this one would have.
const CAS_ATTEMPTS = 3;

export async function recordRestart(phoneNumber: string): Promise<{
  state: SendStallState;
  previous: SendStallState | null;
  previousTtlMs: number | null;
  // Exactly what was written, so a rollback can prove the key is still its own
  // before touching it.
  wrote: string;
}> {
  const key = clusterKeys.sendStall(phoneNumber);
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const raw = await redis.get(key);
    const previous = parseState(raw);
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
    const wrote = JSON.stringify(state);
    const applied = await redis.eval(CAS_SCRIPT, {
      keys: [key],
      arguments: [raw ?? "", wrote, String(SEND_STALL_TTL_MS)],
    });
    if (applied === 1) {
      // `previous` travels back so a caller whose restart is cancelled after the
      // fact can undo exactly its own increment. Deleting instead would hand the
      // phone a clean slate it did not earn: the history in here is per phone and
      // lives 24h, so an earlier genuine strike would go with it.
      return { state, previous, previousTtlMs, wrote };
    }
  }
  // Throwing rather than forcing the write, and the caller treats it as it does
  // any other failure to record: suppress, do not restart blind. That is the
  // right answer here too -- losing every attempt means another owner recorded
  // its own strike, so this phone is already accounted for.
  throw new Error(
    `send-stall strike for ${phoneNumber} lost every compare-and-set attempt`,
  );
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
  ttlMs: number | null,
  // What recordRestart wrote. The undo only applies while the key is still that
  // exact value: a newer owner's strike landing in between is a real event this
  // rollback knows nothing about, and putting our `previous` back over it would
  // erase the whole history on the one phone that is flapping between instances.
  expected: string,
): Promise<void> {
  const key = clusterKeys.sendStall(phoneNumber);
  if (previous === null) {
    await redis.eval(CAD_SCRIPT, { keys: [key], arguments: [expected] });
    return;
  }
  await redis.eval(CAS_SCRIPT, {
    keys: [key],
    arguments: [
      expected,
      JSON.stringify(previous),
      // The expiry the key had when recordRestart found it, not a fresh one. The
      // window is per phone and slides with each GENUINE restart; a restart that
      // was called off must not slide it, or an old history keeps escalating the
      // backoff for up to a day longer than it earned.
      String(ttlMs ?? SEND_STALL_TTL_MS),
    ],
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
