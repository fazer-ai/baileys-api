import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
// Deep specifier on purpose. The preload mocks "@whiskeysockets/baileys", so
// importing the package would hand us the fake socket and never exercise the
// patch. The package has no "exports" map, so this path resolves the real,
// patched file — which is the only way these tests mean anything.
import { addTransactionCapability } from "@whiskeysockets/baileys/lib/Utils/auth-utils.js";

const PATCHED_FILE =
  "node_modules/@whiskeysockets/baileys/lib/Utils/auth-utils.js";

const silentLogger = {
  level: "silent",
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
} as unknown as Parameters<typeof addTransactionCapability>[1];

function makeStore() {
  const sets: unknown[] = [];
  return {
    sets,
    store: {
      get: async () => ({}),
      set: async (data: unknown) => {
        sets.push(data);
      },
      clear: async () => {},
    },
  };
}

function makeKeys(opts: Record<string, unknown> = {}) {
  const { store, sets } = makeStore();
  const keys = addTransactionCapability(store, silentLogger, {
    maxCommitRetries: 1,
    delayBetweenTriesMs: 1,
    ...opts,
  });
  return { keys, sets };
}

const ME = "5511999999999:1@s.whatsapp.net";
const BYTES = new Uint8Array([1, 2, 3]);

describe("addTransactionCapability patch", () => {
  // The number one failure mode of a patch-based fix is the patch silently not
  // applying after a dependency bump or a lockfile change. Everything else here
  // would still pass against stale-but-loaded code, so check the file on disk.
  it("is actually present in the installed package", () => {
    const source = readFileSync(PATCHED_FILE, "utf8");
    expect(source).toContain("E_TX_MUTEX_TIMEOUT");
    expect(source).toContain("withTimeout");
  });

  it("behaves exactly like upstream when the timeout is disabled", async () => {
    const { keys, sets } = makeKeys({ acquireTimeoutMs: 0 });

    await keys.transaction(async () => {
      await keys.set({ session: { a: BYTES } });
    }, ME);
    await keys.transaction(async () => {
      await keys.set({ session: { b: BYTES } });
    }, ME);

    expect(sets).toEqual([
      { session: { a: BYTES } },
      { session: { b: BYTES } },
    ]);
  });

  // Reproduces the production failure in milliseconds: a holder that never
  // returns. Before the patch this second transaction waited forever, with no
  // error, no log and no close — the silent send stall.
  it("rejects a waiter when the holder never returns", async () => {
    const { keys } = makeKeys({ acquireTimeoutMs: 50 });

    // Deliberately not awaited: this is the wedged holder.
    void keys.transaction(() => new Promise<never>(() => {}), ME);
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(keys.transaction(async () => "second", ME)).rejects.toThrow(
      /E_TX_MUTEX_TIMEOUT|timed out acquiring lock/,
    );
  });

  it("carries the key on the timeout error", async () => {
    const { keys } = makeKeys({ acquireTimeoutMs: 50 });
    void keys.transaction(() => new Promise<never>(() => {}), ME);
    await new Promise((resolve) => setTimeout(resolve, 5));

    let caught: { data?: Record<string, unknown> } | undefined;
    try {
      await keys.transaction(async () => "second", ME);
    } catch (e) {
      caught = e as { data?: Record<string, unknown> };
    }

    expect(caught?.data?.key).toBe(ME);
    expect(caught?.data?.code).toBe("E_TX_MUTEX_TIMEOUT");
  });

  // The safety property the whole design rests on: bounding ACQUISITION means
  // a timed-out waiter never entered the transaction, so it read nothing, wrote
  // nothing and committed nothing. A deadline on the work itself would instead
  // abandon it mid-flight and could leave Signal state half-committed.
  it("leaves no trace of the transaction that timed out", async () => {
    const { keys, sets } = makeKeys({ acquireTimeoutMs: 50 });
    void keys.transaction(() => new Promise<never>(() => {}), ME);
    await new Promise((resolve) => setTimeout(resolve, 5));

    let ran = false;
    await keys
      .transaction(async () => {
        ran = true;
        await keys.set({ session: { never: BYTES } });
      }, ME)
      .catch(() => {});

    expect(ran).toBe(false);
    expect(sets).toEqual([]);
  });

  // Guards the `existing` short-circuit: a nested transaction reuses the
  // context and must NOT try to take the mutex its own parent is holding.
  it("does not time out a nested transaction on the same key", async () => {
    const { keys } = makeKeys({ acquireTimeoutMs: 50 });

    const result = await keys.transaction(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return keys.transaction(async () => "inner", ME);
    }, ME);

    expect(result).toBe("inner");
  });

  // A timeout must not poison the mutex: the waiter's abandoned acquire is
  // released as soon as it resolves, so later transactions still work.
  it("recovers once the holder finally releases", async () => {
    const { keys } = makeKeys({ acquireTimeoutMs: 50 });

    let release: () => void = () => {};
    void keys.transaction(
      () => new Promise<void>((resolve) => (release = resolve)),
      ME,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(keys.transaction(async () => "a", ME)).rejects.toThrow();
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(keys.transaction(async () => "b", ME)).resolves.toBe("b");
  });

  // A wedged holder never reaches any finally, so hold time is only observable
  // from a timer armed at acquisition. This report — with the origin stack — is
  // what names the culprit among the operations sharing the `meId` key.
  it("reports a holder that keeps the mutex, with its origin stack", async () => {
    const events: { phase: string; key: string; originStack?: string }[] = [];
    const { keys } = makeKeys({
      acquireTimeoutMs: 0,
      holdWarnMs: 20,
      onTransactionEvent: (event: (typeof events)[number]) =>
        events.push(event),
    });

    void keys.transaction(() => new Promise<never>(() => {}), ME);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const stalled = events.filter((event) => event.phase === "stalled");
    expect(stalled.length).toBeGreaterThan(0);
    expect(stalled[0]?.key).toBe(ME);
    expect(stalled[0]?.originStack).toContain("auth-utils");
  });

  it("does not report a stall for a transaction that finishes promptly", async () => {
    const events: { phase: string }[] = [];
    const { keys } = makeKeys({
      holdWarnMs: 50,
      onTransactionEvent: (event: (typeof events)[number]) =>
        events.push(event),
    });

    await keys.transaction(async () => "quick", ME);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(events.some((event) => event.phase === "stalled")).toBe(false);
    expect(events.map((event) => event.phase)).toEqual([
      "acquired",
      "released",
    ]);
  });

  it("does not leave an unhandled rejection behind", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const { keys } = makeKeys({ acquireTimeoutMs: 30 });
      void keys.transaction(() => new Promise<never>(() => {}), ME);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await keys.transaction(async () => "x", ME).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
