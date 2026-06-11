import redis from "@/lib/redis";

// Cursor-based replacement for redis.keys(). KEYS is O(N) over the entire
// keyspace and blocks the single-threaded Redis server for the whole scan;
// in the cluster claim loop it runs every few seconds on every worker, so a
// large keyspace turns it into recurring head-of-line latency for all
// commands. SCAN walks the keyspace incrementally in bounded batches, never
// blocking longer than one COUNT-sized step.
//
// Trade-off: SCAN gives a weakly-consistent snapshot (keys added/removed
// mid-scan may be missed or duplicated). Both call sites tolerate this — the
// claim loop re-runs continuously and de-duplicates by phone, so a key missed
// on one pass is picked up on the next. The same key CAN legitimately appear in
// more than one batch (SCAN guarantees no omissions, not no repeats), so we
// collect into a Set to hand callers a deduplicated list.
export async function scanKeys(
  pattern: string,
  count = 250,
): Promise<string[]> {
  const keys = new Set<string>();
  for await (const batch of redis.scanIterator({
    MATCH: pattern,
    COUNT: count,
  })) {
    // node-redis v6 yields one array (a SCAN reply batch) per iteration.
    for (const key of batch) {
      keys.add(key);
    }
  }
  return [...keys];
}
