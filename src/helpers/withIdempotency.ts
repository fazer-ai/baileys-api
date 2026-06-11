import { instanceId } from "@/cluster/identity";
import { isInstanceAlive } from "@/cluster/instanceRegistry";
import { errorToString } from "@/helpers/errorToString";
import logger from "@/lib/logger";
import redis from "@/lib/redis";

const IDEMPOTENCY_TTL = 600;
const PROCESSING_PREFIX = "processing:";

// The in-flight marker now carries the holder's instance id so a different
// instance can tell a genuinely-active lock from one orphaned by a crashed
// holder. Without this, a worker that dies mid-send leaves the lock at
// "processing" for the full IDEMPOTENCY_TTL (600s); after failover the new
// owner cannot re-send that message until the TTL lapses. The legacy bare
// "processing" value (written by pre-upgrade instances) is still recognized as
// a marker, but with an unknown holder it is never stolen.
const processingValue = () => `${PROCESSING_PREFIX}${instanceId}`;

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
  | { status: "failed" };

export async function withIdempotency<T>(
  key: string | null,
  fn: () => Promise<T | null>,
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
  if (outcome.status === "processing") {
    return { status: "processing" };
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
    await releaseLock(key);
    throw error;
  }
}

type AcquireOutcome<T> =
  | { status: "owned" }
  | { status: "cached"; value: T }
  | { status: "processing" };

async function acquireOrSteal<T>(key: string): Promise<AcquireOutcome<T>> {
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

  const holder = parseHolder(current);
  if (holder === null) {
    // Not a marker → a cached result.
    try {
      return { status: "cached", value: JSON.parse(current) as T };
    } catch {
      return { status: "processing" };
    }
  }

  // A live holder (or our own concurrent request, or a legacy marker with no
  // identifiable holder) is left alone.
  if (holder === "" || holder === instanceId) {
    return { status: "processing" };
  }
  let alive: boolean;
  try {
    alive = await isInstanceAlive(holder);
  } catch {
    // Cannot confirm death → do not steal.
    return { status: "processing" };
  }
  if (alive) {
    return { status: "processing" };
  }

  // Holder is gone: reclaim the orphaned lock atomically.
  if (await stealLock(key, current)) {
    logger.info(
      "[withIdempotency] reclaimed orphaned lock %s from dead instance %s",
      key,
      holder,
    );
    return { status: "owned" };
  }
  return { status: "processing" };
}

// Returns the holder instance id for an in-flight marker (empty string for the
// legacy bare "processing" value), or null when the value is a cached result.
function parseHolder(value: string): string | null {
  if (value === "processing") return "";
  if (value.startsWith(PROCESSING_PREFIX)) {
    return value.slice(PROCESSING_PREFIX.length);
  }
  return null;
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
