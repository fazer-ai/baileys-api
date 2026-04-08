import { errorToString } from "@/helpers/errorToString";
import logger from "@/lib/logger";
import redis from "@/lib/redis";

const IDEMPOTENCY_TTL = 600;
const PROCESSING_VALUE = "processing";

type IdempotencyResult<T> =
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

  const acquired = await acquireLock(key);
  if (!acquired) {
    const cached = await getCachedResult<T>(key);
    if (cached !== null) return { status: "cached", value: cached };
    return { status: "processing" };
  }

  const value = await fn();

  if (value === null) {
    await releaseLock(key);
    return { status: "failed" };
  }

  await cacheResult(key, value);
  return { status: "executed", value };
}

async function acquireLock(key: string): Promise<boolean> {
  try {
    const result = await redis.set(key, PROCESSING_VALUE, {
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

async function getCachedResult<T>(key: string): Promise<T | null> {
  try {
    const cached = await redis.get(key);
    if (cached && cached !== PROCESSING_VALUE) {
      return JSON.parse(cached) as T;
    }
    return null;
  } catch (error) {
    logger.warn(
      "[withIdempotency] cache read failed: %s",
      errorToString(error),
    );
    return null;
  }
}

async function releaseLock(key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch {
    /* fail-open */
  }
}

async function cacheResult<T>(key: string, value: T): Promise<void> {
  try {
    await redis.set(key, JSON.stringify(value), { EX: IDEMPOTENCY_TTL });
  } catch (error) {
    logger.warn(
      "[withIdempotency] cache write failed: %s",
      errorToString(error),
    );
  }
}
