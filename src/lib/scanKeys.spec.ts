import { afterEach, describe, expect, it } from "bun:test";
import redis from "@/lib/redis";
import { scanKeys } from "./scanKeys";

const hashData = (redis as any).__hashData as Map<string, Map<string, string>>;
const stringData = (redis as any).__stringData as Map<string, string>;

describe("scanKeys", () => {
  afterEach(() => {
    hashData.clear();
    stringData.clear();
  });

  it("returns keys matching the pattern across the keyspace", async () => {
    hashData.set("@baileys-api:connections:+551199:authState", new Map());
    hashData.set("@baileys-api:connections:+551188:authState", new Map());
    stringData.set("@baileys-api:cluster:instance:worker-1", "{}");

    const result = await scanKeys("@baileys-api:connections:*:authState");

    expect(result.sort()).toEqual([
      "@baileys-api:connections:+551188:authState",
      "@baileys-api:connections:+551199:authState",
    ]);
  });

  it("matches keys stored as plain strings (instance registry)", async () => {
    stringData.set("@baileys-api:cluster:instance:worker-1", "{}");
    stringData.set("@baileys-api:cluster:instance:worker-2", "{}");
    stringData.set("@baileys-api:cluster:lease:+551199", "{}");

    const result = await scanKeys("@baileys-api:cluster:instance:*");

    expect(result.sort()).toEqual([
      "@baileys-api:cluster:instance:worker-1",
      "@baileys-api:cluster:instance:worker-2",
    ]);
  });

  it("flattens multiple SCAN batches into a single list", async () => {
    // More keys than the small COUNT below, forcing the iterator to yield
    // several batches that must be concatenated.
    const expected: string[] = [];
    for (let i = 0; i < 25; i++) {
      const key = `@baileys-api:item:${i}`;
      stringData.set(key, "x");
      expected.push(key);
    }

    const result = await scanKeys("@baileys-api:item:*", 10);

    expect(result.sort()).toEqual(expected.sort());
  });

  it("returns an empty list when nothing matches", async () => {
    stringData.set("@baileys-api:other:1", "x");

    const result = await scanKeys("@baileys-api:missing:*");

    expect(result).toEqual([]);
  });
});
