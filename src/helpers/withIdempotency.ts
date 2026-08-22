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

// Atomic compare-and-set: only overwrite the orphaned marker if it is still the
// exact value we observed, so two instances racing to reclaim the same dead
// lock cannot both win. KEYS[1]=key, ARGV[1]=expected, ARGV[2]=new, ARGV[3]=ttl.
const STEAL_SCRIPT = `-- steal-if-stale idempotency lock
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
  return 1
end
return 0`;

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
  // Proceed even when a previous attempt left an indeterminate marker. Only for
  // callers whose retry cannot produce a second message — a caller-reserved
  // WhatsApp id, which the server dedupes on. Without this the marker is a dead
  // end: it outlives the retries by design, so every later attempt is refused
  // for as long as it stands, including the one that reserved an id precisely
  // so it could be safely repeated.
  overrideIndeterminate?: boolean;
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

  const outcome = await acquireOrSteal<T>(key, options?.overrideIndeterminate);
  if (outcome.status === "cached") {
    return { status: "cached", value: outcome.value };
  }
  if (outcome.status === "processing" || outcome.status === "indeterminate") {
    return { status: outcome.status };
  }

  // outcome.status === "owned": we hold the lock, run the work.
  try {
    const value = await fn();

    if (value === null) {
      await releaseLock(key);
      return { status: "failed" };
    }

    const cached = await cacheResult(key, value);
    if (!cached) await releaseLock(key);

    return { status: "executed", value };
  } catch (error) {
    if (options?.isIndeterminate?.(error)) {
      await markIndeterminate(key);
    } else {
      await releaseLock(key);
    }
    throw error;
  }
}

type AcquireOutcome<T> =
  | { status: "owned" }
  | { status: "cached"; value: T }
  | { status: "processing" }
  | { status: "indeterminate" };

async function acquireOrSteal<T>(
  key: string,
  overrideIndeterminate?: boolean,
): Promise<AcquireOutcome<T>> {
  if (await acquireLock(key)) {
    return { status: "owned" };
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
    return (await acquireLock(key))
      ? { status: "owned" }
      : { status: "processing" };
  }

  // Our own genuine in-flight request (exact match incl. our incarnation).
  if (current === processingValue()) {
    return { status: "processing" };
  }

  // An unknown outcome stays unknown for anyone who could duplicate by retrying:
  // deliberately no steal-on-dead-holder path here, since a dead holder tells us
  // nothing about whether its send reached WhatsApp. The one caller allowed past
  // is the one whose retry cannot produce a second message, and for it the marker
  // is not information worth keeping — it is the thing standing between a stuck
  // message and the safe resend that clears it.
  if (current.startsWith(INDETERMINATE_PREFIX)) {
    if (!overrideIndeterminate) {
      return { status: "indeterminate" };
    }
    return (await stealLock(key, current))
      ? { status: "owned" }
      : { status: "processing" };
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
    logger.info(
      "[withIdempotency] reclaimed orphaned lock %s from dead holder %s",
      key,
      holder.incarnationId
        ? `${holder.instanceId}#${holder.incarnationId}`
        : holder.instanceId,
    );
    return { status: "owned" };
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

async function acquireLock(key: string): Promise<boolean> {
  try {
    const result = await redis.set(key, processingValue(), {
      NX: true,
      EX: IDEMPOTENCY_TTL,
    });
    return result === "OK";
  } catch (error) {
    logger.warn(
      "[withIdempotency] lock acquire failed, proceeding without cache: %s",
      errorToString(error),
    );
    return true;
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

async function markIndeterminate(key: string): Promise<void> {
  try {
    await redis.set(
      key,
      `${INDETERMINATE_PREFIX}${instanceId}#${incarnationId}`,
      { EX: INDETERMINATE_TTL },
    );
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
  }
}

async function releaseLock(key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch {
    /* fail-open */
  }
}

async function cacheResult<T>(key: string, value: T): Promise<boolean> {
  try {
    await redis.set(key, JSON.stringify(value), { EX: IDEMPOTENCY_TTL });
    return true;
  } catch (error) {
    logger.warn(
      "[withIdempotency] cache write failed: %s",
      errorToString(error),
    );
    return false;
  }
}
