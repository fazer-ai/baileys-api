import { describe, expect, it } from "bun:test";
import { asyncSleep } from "./asyncSleep";

describe("asyncSleep", () => {
  it("resolves without throwing", async () => {
    await asyncSleep(0);
  });

  it("returns a Promise<void>", async () => {
    const result = await asyncSleep(0);
    expect(result).toBeUndefined();
  });
});
