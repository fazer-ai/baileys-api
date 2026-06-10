import { LRUCache } from "lru-cache";
import type { OwnershipChangedEvent } from "@/cluster/instanceRegistry";
import { clusterKeys } from "@/cluster/keys";
import config from "@/config";
import { errorToString } from "@/helpers/errorToString";
import logger from "@/lib/logger";
import { createSubscriberClient } from "@/lib/redis";

export interface RouteTarget {
  instanceId: string;
  baseUrl: string;
}

// Short TTL bounds staleness even if the pub/sub invalidation never arrives;
// the workers' 421 responses are the final corrector. The cache exists to
// avoid two Redis round-trips (lease + instance) per proxied request.
const cache = new LRUCache<string, RouteTarget>({
  max: 10_000,
  ttl: config.proxy.routeCacheTtlMs,
});

export function getCachedTarget(phoneNumber: string): RouteTarget | undefined {
  return cache.get(phoneNumber);
}

export function setCachedTarget(phoneNumber: string, target: RouteTarget) {
  cache.set(phoneNumber, target);
}

export function invalidateTarget(phoneNumber: string) {
  cache.delete(phoneNumber);
}

export async function startRouteCacheInvalidation() {
  const subscriber = createSubscriberClient();
  subscriber.on("error", (error: unknown) => {
    logger.error(
      "Route cache subscriber error: %s",
      errorToString(error as Error),
    );
  });
  await subscriber.connect();
  await subscriber.subscribe(clusterKeys.eventsChannel, (message: string) => {
    try {
      const event = JSON.parse(message) as OwnershipChangedEvent;
      if (event.type === "ownership.changed") {
        if (!event.phoneNumber) {
          logger.warn("Ignoring ownership.changed event without phoneNumber");
          return;
        }
        invalidateTarget(event.phoneNumber);
      }
    } catch (error) {
      logger.warn(
        "Ignoring malformed cluster event: %s",
        errorToString(error as Error),
      );
    }
  });
}
