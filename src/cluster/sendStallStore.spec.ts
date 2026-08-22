import { afterEach, describe, expect, it } from "bun:test";
import redis from "@/lib/redis";
import {
  backoffMs,
  canRestart,
  clearSendStall,
  nextRestartAllowedAt,
  recordRestart,
  restoreState,
} from "./sendStallStore";

const stringData = (redis as any).__stringData as Map<string, string>;
const expirations = (redis as any).__expirations as Map<
  string,
  { type: string; value: number }
>;
const PHONE = "+5511999999999";
const KEY = `@baileys-api:cluster:send-stall:${PHONE}`;

describe("sendStallStore", () => {
  afterEach(() => {
    stringData.clear();
    expirations.clear();
  });

  // Recovering fast the first time is the whole point; the backoff only exists
  // to stop a phone that restarting clearly is not curing.
  it("allows the first restart immediately", async () => {
    expect(await canRestart(PHONE)).toBe(true);
  });

  it("holds off a second restart inside the backoff window", async () => {
    await recordRestart(PHONE);
    expect(await canRestart(PHONE)).toBe(false);
  });

  it("escalates the backoff on repeated restarts", async () => {
    expect(backoffMs(1)).toBe(5 * 60 * 1000);
    expect(backoffMs(2)).toBe(10 * 60 * 1000);
    expect(backoffMs(3)).toBe(20 * 60 * 1000);
  });

  it("caps the backoff at an hour", () => {
    expect(backoffMs(50)).toBe(60 * 60 * 1000);
  });

  it("counts restarts across calls", async () => {
    await recordRestart(PHONE);
    const second = await recordRestart(PHONE);
    expect(second.state.restarts).toBe(2);
    // The caller gets what it is undoing, not just what it wrote.
    expect(second.previous?.restarts).toBe(1);
  });

  it("reports when the next restart becomes allowed", async () => {
    const { state } = await recordRestart(PHONE);
    expect(await nextRestartAllowedAt(PHONE)).toBe(state.nextRestartAllowedAt);
  });

  // A restart cancelled after the strike was written has to undo exactly its own
  // increment. Deleting the key would also wipe an earlier genuine strike and
  // hand the phone a clean slate it did not earn.
  it("restores the state a cancelled restart replaced", async () => {
    const first = await recordRestart(PHONE);
    const second = await recordRestart(PHONE);
    expect(second.state.restarts).toBe(2);

    await restoreState(PHONE, second.previous);

    expect(await nextRestartAllowedAt(PHONE)).toBe(
      first.state.nextRestartAllowedAt,
    );
  });

  // The 24h window is per phone and slides with each GENUINE restart. A restart
  // that was called off must not slide it: restoring with a fresh lifetime gives
  // an old history another full day to escalate the backoff from, on the
  // strength of a restart that never happened.
  it("puts back the expiry the cancelled restart found, not a fresh one", async () => {
    await recordRestart(PHONE);
    // The key is near the end of its day by the time the second episode starts.
    expirations.set(KEY, { type: "PX", value: 60_000 });

    const second = await recordRestart(PHONE);
    expect(second.previousTtlMs).toBe(60_000);
    // The genuine strike did slide it.
    expect(expirations.get(KEY)).toEqual({
      type: "PX",
      value: 24 * 60 * 60 * 1000,
    });

    await restoreState(PHONE, second.previous, second.previousTtlMs);

    expect(expirations.get(KEY)).toEqual({ type: "PX", value: 60_000 });
  });

  // No expiry (-1) and no key (-2) are not durations. Falling back to the full
  // lifetime is the safe direction: the alternative is writing a key that never
  // expires.
  it("falls back to a full lifetime when the previous expiry is unreadable", async () => {
    stringData.set(
      KEY,
      JSON.stringify({ restarts: 1, nextRestartAllowedAt: Date.now() - 1 }),
    );
    // Written without any expiration -- what a pre-upgrade instance left behind.
    const second = await recordRestart(PHONE);
    expect(second.previousTtlMs).toBeNull();

    await restoreState(PHONE, second.previous, second.previousTtlMs);

    expect(expirations.get(KEY)).toEqual({
      type: "PX",
      value: 24 * 60 * 60 * 1000,
    });
  });

  it("clears the key when the cancelled restart was the first", async () => {
    const first = await recordRestart(PHONE);
    expect(first.previous).toBeNull();

    await restoreState(PHONE, first.previous);

    expect(await nextRestartAllowedAt(PHONE)).toBeNull();
  });

  it("returns null when no stall has been recorded", async () => {
    expect(await nextRestartAllowedAt(PHONE)).toBeNull();
  });

  it("allows a restart again once the window has passed", async () => {
    stringData.set(
      KEY,
      JSON.stringify({ restarts: 1, nextRestartAllowedAt: Date.now() - 1 }),
    );
    expect(await canRestart(PHONE)).toBe(true);
  });

  // A corrupted entry must not wedge recovery shut.
  it("treats an unparseable entry as no backoff", async () => {
    stringData.set(KEY, "not json");
    expect(await canRestart(PHONE)).toBe(true);
  });

  it("clears the state", async () => {
    await recordRestart(PHONE);
    await clearSendStall(PHONE);
    expect(await canRestart(PHONE)).toBe(true);
  });
});
