import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
// Deep specifier on purpose. The preload mocks "@whiskeysockets/baileys", so
// importing the package would hand us the fake socket and never exercise the
// patch. The package has no "exports" map, so this path resolves the real,
// patched file — which is the only way these tests mean anything.
import { LIDMappingStore } from "@whiskeysockets/baileys/lib/Signal/lid-mapping.js";

const PATCHED_FILE =
  "node_modules/@whiskeysockets/baileys/lib/Signal/lid-mapping.js";

// A business-hosted account is addressed on `hosted` and `hosted.lid`. Upstream derives
// those pairs on purpose in `processHistoryMessage` and hands them to this store, which
// then threw every one of them away: `isPnUser` and `isLidUser` are plain suffix tests
// for the non-hosted form, and they guarded both the write and the reverse read.
const HOSTED_LID = "235085806727321@hosted.lid";
const HOSTED_PN = "5511999999999@hosted";
const PLAIN_LID = "777888999@lid";
const PLAIN_PN = "5511888888888@s.whatsapp.net";

function makeLogger() {
  const warnings: string[] = [];
  const logger = {
    level: "silent",
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    },
    error: () => {},
    child: () => logger,
  };
  return { logger, warnings };
}

// The persisted half of the store: a plain table keyed exactly the way
// `storeLIDPNMappings` writes it, so a second store instance reads what the first wrote
// instead of answering out of its own in-process LRU.
function makeTable() {
  return {} as Record<string, string>;
}

function makeStore(table: Record<string, string>) {
  const { logger, warnings } = makeLogger();
  const keys = {
    get: async (type: string, ids: string[]) => {
      if (type !== "lid-mapping") {
        return {};
      }
      const found: Record<string, string> = {};
      for (const id of ids) {
        const value = table[id];
        if (value) {
          found[id] = value;
        }
      }
      return found;
    },
    set: async (data: Record<string, Record<string, string>>) => {
      Object.assign(table, data["lid-mapping"] ?? {});
    },
    transaction: async (work: () => Promise<void>) => {
      await work();
    },
  };

  // biome-ignore lint/suspicious/noExplicitAny: the store's key/logger types are baileys-internal.
  const store = new LIDMappingStore(keys as any, logger as any, undefined);
  return { store, warnings };
}

describe("hosted LID mapping patch", () => {
  // The number one failure mode of a patch-based fix is the patch silently not
  // applying after a dependency bump or a lockfile change. Everything else here
  // would still pass against stale-but-loaded code, so check the file on disk.
  it("is actually present in the installed package", () => {
    const source = readFileSync(PATCHED_FILE, "utf8");
    expect(source).toContain("isAnyLidUser");
    expect(source).toContain("isAnyPnUser");
  });

  it("stores a hosted pair instead of warning it away", async () => {
    const { store, warnings } = makeStore(makeTable());

    await store.storeLIDPNMappings([{ lid: HOSTED_LID, pn: HOSTED_PN }]);

    expect(warnings).toEqual([]);
  });

  // The whole point: a history dump names the pair once, and every later flush of the
  // same sync arrives without the chat record that carried it. The store is what has to
  // remember, and until this patch it could not.
  it("answers for a hosted LID it was told about earlier", async () => {
    const table = makeTable();
    const first = makeStore(table);
    await first.store.storeLIDPNMappings([{ lid: HOSTED_LID, pn: HOSTED_PN }]);

    // A separate instance, so the answer comes off the persisted table rather than the
    // in-process cache the write populated.
    const second = makeStore(table);

    expect(await second.store.getPNsForLIDs([HOSTED_LID])).toEqual([
      { lid: HOSTED_LID, pn: "5511999999999:0@hosted" },
    ]);
  });

  // The device suffix is the store's own doing, and a live message never carries one.
  // `lidPnIndex` in historySync.ts strips it; this pins the shape it has to strip.
  it("answers with the hosted phone domain, not the ordinary one", async () => {
    const table = makeTable();
    const { store } = makeStore(table);
    await store.storeLIDPNMappings([{ lid: HOSTED_LID, pn: HOSTED_PN }]);

    const pn = await store.getPNForLID(HOSTED_LID);

    expect(pn?.endsWith("@hosted")).toBe(true);
  });

  it("still resolves an ordinary LID", async () => {
    const table = makeTable();
    const { store } = makeStore(table);
    await store.storeLIDPNMappings([{ lid: PLAIN_LID, pn: PLAIN_PN }]);

    expect(await store.getPNForLID(PLAIN_LID)).toBe(
      "5511888888888:0@s.whatsapp.net",
    );
  });

  // The table is keyed by user, and the two domains of one account share that user --
  // `hosted` says how the account is reached, not who it is. So the domain of the answer
  // follows the jid that was asked about, not the jid that was stored.
  it("reads a hosted LID and its ordinary form as one account", async () => {
    const table = makeTable();
    const { store } = makeStore(table);
    await store.storeLIDPNMappings([{ lid: HOSTED_LID, pn: HOSTED_PN }]);

    expect(await store.getPNForLID("235085806727321@lid")).toBe(
      "5511999999999:0@s.whatsapp.net",
    );
  });

  // `handleMessage` tests `altServer === 'lid'` strictly, so a hosted alternate takes its
  // else branch and a PN-addressed hosted message hands the pair over the other way round.
  // Upstream decoded positionally, so widening the guard without this would persist those
  // backwards -- worse than dropping them, since the LID would then read as a phone number.
  it("stores a reversed hosted pair the right way round", async () => {
    const table = makeTable();
    const { store, warnings } = makeStore(table);

    await store.storeLIDPNMappings([{ lid: HOSTED_PN, pn: HOSTED_LID }]);

    expect(warnings).toEqual([]);
    expect(await store.getPNForLID(HOSTED_LID)).toBe("5511999999999:0@hosted");
  });

  it("stores a reversed ordinary pair the right way round", async () => {
    const table = makeTable();
    const { store } = makeStore(table);

    await store.storeLIDPNMappings([{ lid: PLAIN_PN, pn: PLAIN_LID }]);

    expect(await store.getPNForLID(PLAIN_LID)).toBe(
      "5511888888888:0@s.whatsapp.net",
    );
  });

  it("refuses a pair that names two LIDs", async () => {
    const { store, warnings } = makeStore(makeTable());

    await store.storeLIDPNMappings([{ lid: HOSTED_LID, pn: PLAIN_LID }]);

    expect(warnings).toHaveLength(1);
    expect(await store.getPNForLID(HOSTED_LID)).toBeNull();
  });

  it("refuses a pair that names two phone numbers", async () => {
    const { store, warnings } = makeStore(makeTable());

    await store.storeLIDPNMappings([{ lid: HOSTED_PN, pn: PLAIN_PN }]);

    expect(warnings).toHaveLength(1);
  });

  it("still refuses a pair that is neither addressing", async () => {
    const { store, warnings } = makeStore(makeTable());

    await store.storeLIDPNMappings([
      { lid: "120363000000000000@g.us", pn: HOSTED_PN },
    ]);

    expect(warnings).toHaveLength(1);
    expect(await store.getPNForLID("120363000000000000@g.us")).toBeNull();
  });
});
