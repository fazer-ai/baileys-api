import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
// Deep specifier on purpose, exactly as in authTransactionTimeout.spec.ts: the
// preload mocks "@whiskeysockets/baileys", and the package has no "exports"
// map, so this path resolves the real, patched file.
import { getUrlInfo } from "@whiskeysockets/baileys/lib/Utils/link-preview.js";

const PATCHED_FILE =
  "node_modules/@whiskeysockets/baileys/lib/Utils/link-preview.js";

describe("patched link preview", () => {
  // The number-one failure mode of a fix delivered by patch is the patch
  // silently not applying. Cheap guard, same as the transaction sentinel.
  it("carries the abort signal into the installed file", () => {
    expect(readFileSync(PATCHED_FILE, "utf8")).toContain("AbortSignal.timeout");
  });

  // The same shape as the bug this whole change is about: a fetch with no
  // deadline, on the send path. This one does not sit inside the keystore mutex,
  // so it does not mute the connection -- it holds the send until the app-level
  // deadline gives up, counts a stall strike against a healthy keystore, and
  // leaks the request. Three of those open the breaker on a connection whose
  // mutex was never touched.
  it("aborts a parked YouTube oEmbed request instead of holding the send", async () => {
    const originalFetch = globalThis.fetch;
    let seenSignal: AbortSignal | null = null;
    globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) => {
      seenSignal = init?.signal ?? null;
      // Never resolves on its own: only the signal can end this.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    }) as unknown as typeof fetch;

    try {
      // Raced rather than awaited: without the signal this never settles, and a
      // hung example is a worse CI failure than a failed assertion.
      const outcome = await Promise.race([
        getUrlInfo("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
          thumbnailWidth: 192,
          fetchOpts: { timeout: 20 },
          // getUrlInfo rethrows anything that is not a "receive a valid" parse
          // failure, so the abort surfaces as a rejection. Either way is a pass:
          // the property under test is that it SETTLES.
        } as never).then(
          () => "settled",
          () => "settled",
        ),
        new Promise((resolve) => setTimeout(() => resolve("hung"), 500)),
      ]);

      expect(seenSignal).not.toBeNull();
      expect(outcome).toBe("settled");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
