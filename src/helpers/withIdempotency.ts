import { incarnationId, instanceId } from "@/cluster/identity";
import { isInstanceAlive } from "@/cluster/instanceRegistry";
import { errorToString } from "@/helpers/errorToString";
import logger from "@/lib/logger";
import redis from "@/lib/redis";

const IDEMPOTENCY_TTL = 600;
// An unknown outcome outlives a cached result by design, and by a lot. The 600s above
// bounds a convenience: how long a repeated request gets the same answer for free. This
// one bounds a safety record, and it has to outlive both the abandoned operation (which
// nothing cancels — it sits in the socket's keystore mutex until that socket dies) and
// the human who has to reconcile it. At 600s a send that finally landed 11 minutes late
// would find its marker gone and let a retry duplicate the message, which is the one
// outcome the marker exists to prevent.
//
// 24h is a bound, not a proof. What actually ends the danger is the socket dying,
// since a parked send cannot reach WhatsApp once its socket is gone; the longest
// wedge observed in production was 6h08, and the mutex-acquire timeout shortens
// the wait further whenever it is enabled. It is NOT bounded with the
// BAILEYS_TX_ACQUIRE_TIMEOUT_MS=0 kill switch thrown, so a socket wedged past a
// full day under that setting could see a retry go out beside a send that later
// lands. The alternative is a marker with no expiry, which trades a documented,
// bounded risk for unbounded key growth; this is the deliberate side of that
// trade, and the kill switch carries the caveat.
const INDETERMINATE_TTL = 86_400;
const PROCESSING_PREFIX = "processing:";
// Marks work that threw in a way that leaves the outcome unknowable — a send
// that timed out is still parked inside the socket's keystore mutex and may
// yet reach WhatsApp. Deleting the key would make the request freely
// retryable and risk a duplicate; leaving the `processing:` marker would 409
// every retry for the full TTL with no way to tell why. Neither is right, so
// the state is recorded distinctly and the caller decides what to answer.
const INDETERMINATE_PREFIX = "indeterminate:";

// The in-flight marker carries the holder's instance id AND a per-process
// incarnation token ("processing:<instanceId>#<incarnationId>") so a different
// instance can tell a genuinely-active lock from one orphaned by a crashed
// holder. Without this, a worker that dies mid-send leaves the lock at
// "processing" for the full IDEMPOTENCY_TTL (600s); after failover the new
// owner cannot re-send that message until the TTL lapses. The incarnation
// token additionally lets a process that restarts under a pinned INSTANCE_ID
// reclaim a lock left by its own previous incarnation — same instanceId, but a
// different incarnationId, so the registry (which the new incarnation has
// already re-registered under that same id) cannot be consulted to prove the
// old holder dead. The legacy bare "processing" value (written by pre-upgrade
// instances) is still recognized as a marker, but with an unknown holder it is
// never stolen.
//
// The incarnation is delimited with "#", not ":", so the split stays
// unambiguous even when INSTANCE_ID itself contains colons (e.g. "host:port"):
// the base36 incarnationId never contains "#", and "#" is far less likely than
// ":" in a user-supplied id.
const processingValue = () =>
  `${PROCESSING_PREFIX}${instanceId}#${incarnationId}`;

// The indeterminate marker carries a per-ATTEMPT suffix on top of the
// per-process identity, because two attempts in one process would otherwise
// write a byte-identical value -- and the late retraction compares against that
// value to prove the marker is still its own. Unlike the processing marker,
// nothing parses this one (acquireOrSteal only checks its prefix), so the extra
// segment costs nothing.
let attemptCounter = 0;
const indeterminateValue = () => {
  attemptCounter += 1;
  return `${INDETERMINATE_PREFIX}${instanceId}#${incarnationId}#${attemptCounter.toString(36)}`;
};

// Atomic compare-and-set: only overwrite the orphaned marker if it is still the
// exact value we observed, so two instances racing to reclaim the same dead
// lock cannot both win. KEYS[1]=key, ARGV[1]=expected, ARGV[2]=new, ARGV[3]=ttl.
const STEAL_SCRIPT = `-- steal-if-stale idempotency lock
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
  return 1
end
return 0`;

// Compare-and-delete against the EXACT marker this attempt wrote, not merely
// against the prefix. By the time a late verdict runs the request is long gone
// and anything may sit under the key: a retry that got past a cleared marker and
// cached its result, or -- the case a prefix check cannot see -- a retry's OWN
// indeterminate marker, whose outcome is still unknown. Dropping that one strips
// the protection off a live attempt and lets a third send go out.
// KEYS[1]=key, ARGV[1]=the marker written by the attempt now retracting it.
const CLEAR_INDETERMINATE_SCRIPT = `-- clear-indeterminate
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("DEL", KEYS[1])
  return 1
end
return 0`;

// Compare-and-set, for the fail-open case. acquireLock returns success when it
// cannot reach Redis, so this request may hold no lock at all: by the time it
// gives up, a retry (or another instance) can have taken the key and even cached
// a successful result under it. An unconditional SET would bury that result under
// an "outcome unknown" that then 409s every later caller for 24h -- for a message
// that demonstrably went out. Write only over our own processing marker, or over
// nothing. KEYS[1]=key, ARGV=[ourProcessingValue, marker, ttl].
const WRITE_IF_OURS_SCRIPT = `-- mark-indeterminate write-if-ours
local raw = redis.call("GET", KEYS[1])
if raw == false or (ARGV[4] == "1" and raw == ARGV[1]) then
  redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
  return 1
end
return 0`;

// Same rule for the release: you may only delete what you hold. On the fail-open
// path there is nothing of ours under the key, so a DEL there would drop a
// successor's live lock -- or its cached result. KEYS[1]=key, ARGV[1]=our marker.
const RELEASE_IF_OURS_SCRIPT = `-- release-if-ours
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("DEL", KEYS[1])
  return 1
end
return 0`;

// Retracts an "outcome unknown" once the outcome becomes known to be "did not
// happen". Only one thing proves that: a mutex-acquire timeout, whose waiter
// never entered the transaction and so cannot have reached WhatsApp. Everything
// else that arrives late is still ambiguous and must leave the marker standing.
//
// Worth doing rather than letting the marker expire, because the marker is what
// makes an operator's resend of the SAME message answer 409 for 24h. Once the
// send is known not to have happened, that retry is exactly the right thing and
// nothing should be blocking it.
export async function clearIndeterminate(
  key: string,
  marker: string,
): Promise<boolean> {
  try {
    const result = await redis.eval(CLEAR_INDETERMINATE_SCRIPT, {
      keys: [key],
      arguments: [marker],
    });
    return result === 1;
  } catch (error) {
    logger.warn(
      "[withIdempotency] failed to clear indeterminate marker %s: %s",
      key,
      errorToString(error),
    );
    return false;
  }
}

export type IdempotencyResult<T> =
  | { status: "executed"; value: T }
  | { status: "cached"; value: T }
  | { status: "processing" }
  | { status: "indeterminate" }
  | { status: "failed" };

export interface IdempotencyOptions {
  // Predicate for "the work threw, but it may still take effect". Returning
  // true records the indeterminate marker instead of releasing the lock.
  isIndeterminate?: (error: unknown) => boolean;
  // The marker that actually reached Redis, or null if none did. Everything in
  // this module fails open -- acquireLock returns success when it cannot write,
  // and markIndeterminate only warns -- so holding a key is NOT evidence that a
  // retry is protected. The value itself is handed back rather than a boolean
  // because a later retraction has to prove the marker is still the one this
  // attempt wrote before deleting it.
  onIndeterminate?: (marker: string | null) => void;
}

export async function withIdempotency<T>(
  key: string | null,
  fn: () => Promise<T | null>,
  options?: IdempotencyOptions,
): Promise<IdempotencyResult<T>> {
  if (!key) {
    const value = await fn();
    return value !== null
      ? { status: "executed", value }
      : { status: "failed" };
  }

  const outcome = await acquireOrSteal<T>(key);
  if (outcome.status === "cached") {
    return { status: "cached", value: outcome.value };
  }
  if (outcome.status === "processing" || outcome.status === "indeterminate") {
    return { status: outcome.status };
  }

  // outcome.status === "owned": run the work. `held` says whether the key is
  // actually ours; on the fail-open path it is not, and every write below is
  // conditioned on that.
  const held = outcome.held;
  try {
    const value = await fn();

    if (value === null) {
      await releaseLock(key, held);
      return { status: "failed" };
    }

    const cached = await cacheResult(key, value, held);
    if (!cached) await releaseLock(key, held);

    return { status: "executed", value };
  } catch (error) {
    if (options?.isIndeterminate?.(error)) {
      // Two statements, deliberately. `options.onIndeterminate?.(await mark(...))`
      // reads the same but is not: optional chaining short-circuits the whole
      // call expression when the callback is absent, arguments included, so the
      // marker would never be written for any caller that did not pass one.
      const marker = await markIndeterminate(key, held);
      options.onIndeterminate?.(marker);
    } else {
      await releaseLock(key, held);
    }
    throw error;
  }
}

type AcquireOutcome<T> =
  // `held` is false only on the fail-open path: we are running the work, but the
  // key is not ours and may belong to someone else by the time we finish.
  | { status: "owned"; held: boolean }
  | { status: "cached"; value: T }
  | { status: "processing" }
  | { status: "indeterminate" };

async function acquireOrSteal<T>(key: string): Promise<AcquireOutcome<T>> {
  const first = await acquireLock(key);
  if (first !== "taken") {
    return { status: "owned", held: first === "acquired" };
  }

  // Someone else holds the key. Inspect it: it is either a finished result we
  // should return, or an in-flight marker we may be able to reclaim.
  let current: string | null;
  try {
    current = await redis.get(key);
  } catch (error) {
    logger.warn(
      "[withIdempotency] holder inspection failed, treating as processing: %s",
      errorToString(error),
    );
    return { status: "processing" };
  }

  if (current === null) {
    // Released in the gap between the failed NX and this read; try once more.
    const second = await acquireLock(key);
    return second === "taken"
      ? { status: "processing" }
      : { status: "owned", held: second === "acquired" };
  }

  // Our own genuine in-flight request (exact match incl. our incarnation).
  if (current === processingValue()) {
    return { status: "processing" };
  }

  // An unknown outcome stays unknown, for everyone. No steal-on-dead-holder path,
  // since a dead holder tells us nothing about whether its send reached WhatsApp
  // — and no caller override either: a marker is only ever written for a send
  // that had NO reserved id (see isIndeterminate at the send route), so the
  // WhatsApp key that attempt used is unknown to us. A retry supplying a freshly
  // reserved id lands on a DIFFERENT key, which is a second message, not a
  // deduplicated one.
  if (current.startsWith(INDETERMINATE_PREFIX)) {
    return { status: "indeterminate" };
  }

  const holder = parseHolder(current);
  if (holder === null) {
    // Not a marker → a cached result.
    try {
      return { status: "cached", value: JSON.parse(current) as T };
    } catch {
      return { status: "processing" };
    }
  }

  // A legacy bare "processing" marker has no identifiable holder — leave it.
  if (holder.instanceId === "") {
    return { status: "processing" };
  }

  // A marker from a previous incarnation of THIS process (same instanceId, but
  // it died and we are its restart): definitively dead, reclaim immediately —
  // the registry now points at us under that same id and would wrongly report
  // it alive.
  const isOwnDeadIncarnation =
    holder.instanceId === instanceId &&
    holder.incarnationId !== undefined &&
    holder.incarnationId !== incarnationId;

  if (!isOwnDeadIncarnation) {
    let alive: boolean;
    try {
      alive = await isInstanceAlive(holder.instanceId);
    } catch {
      // Cannot confirm death → do not steal.
      return { status: "processing" };
    }
    if (alive) {
      return { status: "processing" };
    }
  }

  // Holder is gone: reclaim the orphaned lock atomically.
  if (await stealLock(key, current)) {
    // A steal leaves OUR processingValue under the key, so this is held.
    logger.info(
      "[withIdempotency] reclaimed orphaned lock %s from dead holder %s",
      key,
      holder.incarnationId
        ? `${holder.instanceId}#${holder.incarnationId}`
        : holder.instanceId,
    );
    return { status: "owned", held: true };
  }
  return { status: "processing" };
}

interface Holder {
  instanceId: string;
  incarnationId: string | undefined;
}

// Parses an in-flight marker into its holder. Returns null when the value is a
// cached result rather than a marker. The legacy bare "processing" value and
// the pre-incarnation "processing:<instanceId>" form are both tolerated
// (instanceId "" / incarnationId undefined respectively).
function parseHolder(value: string): Holder | null {
  if (value === "processing") {
    return { instanceId: "", incarnationId: undefined };
  }
  if (!value.startsWith(PROCESSING_PREFIX)) {
    return null;
  }
  const rest = value.slice(PROCESSING_PREFIX.length);
  // The incarnation token is appended after "#". Splitting on "#" (rather than
  // ":") keeps this unambiguous when instanceId contains colons. A legacy
  // "processing:<instanceId>" marker has no "#" and parses as a bare instanceId.
  const sep = rest.lastIndexOf("#");
  if (sep === -1) {
    return { instanceId: rest, incarnationId: undefined };
  }
  return {
    instanceId: rest.slice(0, sep),
    incarnationId: rest.slice(sep + 1),
  };
}

// Three outcomes, and the third is the one every writer below has to respect.
// "failed-open" means the work runs with NO lock behind it: the key may be free,
// or a retry may take it while we run. Every later write has to know which of
// these it got, because "only ever write over your own marker, or over nothing"
// is the rule that keeps a request that holds nothing from clobbering the one
// that does.
type LockOutcome = "acquired" | "taken" | "failed-open";

async function acquireLock(key: string): Promise<LockOutcome> {
  try {
    const result = await redis.set(key, processingValue(), {
      NX: true,
      EX: IDEMPOTENCY_TTL,
    });
    return result === "OK" ? "acquired" : "taken";
  } catch (error) {
    logger.warn(
      "[withIdempotency] lock acquire failed, proceeding without cache: %s",
      errorToString(error),
    );
    return "failed-open";
  }
}

async function stealLock(key: string, expected: string): Promise<boolean> {
  try {
    const result = await redis.eval(STEAL_SCRIPT, {
      keys: [key],
      arguments: [expected, processingValue(), String(IDEMPOTENCY_TTL)],
    });
    return result === 1;
  } catch (error) {
    logger.warn(
      "[withIdempotency] lock steal failed: %s",
      errorToString(error),
    );
    return false;
  }
}

async function markIndeterminate(
  key: string,
  held: boolean,
): Promise<string | null> {
  const marker = indeterminateValue();
  try {
    const result = await redis.eval(WRITE_IF_OURS_SCRIPT, {
      keys: [key],
      arguments: [
        processingValue(),
        marker,
        String(INDETERMINATE_TTL),
        held ? "1" : "0",
      ],
    });
    if (result !== 1) {
      // A successor owns the key now. Reported as not persisted, which is the
      // conservative reading: a retry may well be safe (if what is sitting there
      // is a cached result, it gets that result back instead of sending), but we
      // cannot tell that from a successor's own in-flight marker, and the caller
      // uses this to decide whether to issue `retry-after`.
      logger.warn(
        "[withIdempotency] %s moved on before it could be marked indeterminate",
        key,
      );
      return null;
    }
    return marker;
  } catch (error) {
    // Leave the `processing:` marker in place rather than releasing: it 409s
    // the retry for the rest of the TTL, which is the safe direction here —
    // releasing would let the retry duplicate a message that may already have
    // gone out. The warn is what tells an operator why the 409 says
    // "processing" for a request that is no longer running.
    logger.warn(
      "[withIdempotency] failed to mark %s indeterminate: %s",
      key,
      errorToString(error),
    );
    return null;
  }
}

async function releaseLock(key: string, held: boolean): Promise<void> {
  // Nothing of ours is under the key on the fail-open path, and the marker there
  // identifies a PROCESS, not an acquisition: a concurrent retry on this same
  // worker writes a byte-identical one. Deleting on that evidence drops the
  // retry's live lock, and the request that gave up then has nothing guarding
  // it.
  if (!held) {
    return;
  }
  try {
    await redis.eval(RELEASE_IF_OURS_SCRIPT, {
      keys: [key],
      arguments: [processingValue()],
    });
  } catch {
    /* fail-open */
  }
}

async function cacheResult<T>(
  key: string,
  value: T,
  held: boolean,
): Promise<boolean> {
  try {
    const result = await redis.eval(WRITE_IF_OURS_SCRIPT, {
      keys: [key],
      arguments: [
        processingValue(),
        JSON.stringify(value),
        String(IDEMPOTENCY_TTL),
        held ? "1" : "0",
      ],
    });
    // Not an error: a successor holds the key, so its answer stands. Reported as
    // "not cached" so the caller does not then try to release a lock it never
    // had -- releaseLock refuses that on its own, and this keeps the two honest
    // together.
    return result === 1;
  } catch (error) {
    logger.warn(
      "[withIdempotency] cache write failed: %s",
      errorToString(error),
    );
    return false;
  }
}
