import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  apiKeyFingerprint,
  parseApiKeysCommand,
  provisionDefaultApiKey,
  runApiKeysCommand,
} from "@/lib/apiKeys";
import logger from "@/lib/logger";
import redis from "@/lib/redis";
import { REDIS_KEY_PREFIX } from "@/middlewares/auth";

const stringData = (redis as any).__stringData as Map<string, string>;
const KEY = "a".repeat(32) + "b".repeat(32);
const storedAuth = (key: string) =>
  stringData.get(`${REDIS_KEY_PREFIX}:${key}`) ?? null;

function capture() {
  const lines: string[] = [];
  return { lines, print: (line: string) => lines.push(line) };
}

beforeEach(() => {
  stringData.clear();
});

describe("apiKeyFingerprint", () => {
  it("is the prefix of the hash stored as a session's apiKeyHash", () => {
    // Operators match the boot line against metadata.apiKeyHash, which the
    // auth middleware computes as the full sha256 hex.
    const full = createHash("sha256").update(KEY).digest("hex");
    expect(full.startsWith(apiKeyFingerprint(KEY))).toBe(true);
    expect(apiKeyFingerprint(KEY)).toHaveLength(8);
  });
});

describe("provisionDefaultApiKey", () => {
  let infoSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    infoSpy = spyOn(logger, "info");
  });
  afterEach(() => {
    infoSpy.mockRestore();
  });

  it("registers a missing key as a user key, logging only its fingerprint", async () => {
    await provisionDefaultApiKey(KEY);

    expect(JSON.parse(storedAuth(KEY) ?? "null")).toEqual({ role: "user" });
    const logged = JSON.stringify(infoSpy.mock.calls);
    expect(logged).not.toContain(KEY);
    expect(logged).toContain(apiKeyFingerprint(KEY));
  });

  it("does not downgrade a key an operator promoted to admin", async () => {
    stringData.set(
      `${REDIS_KEY_PREFIX}:${KEY}`,
      JSON.stringify({ role: "admin" }),
    );

    await provisionDefaultApiKey(KEY);

    expect(JSON.parse(storedAuth(KEY) ?? "null")).toEqual({ role: "admin" });
  });

  it("writes nothing when no default key is configured", async () => {
    await provisionDefaultApiKey("");
    await provisionDefaultApiKey(undefined);

    expect(stringData.size).toBe(0);
  });
});

describe("runApiKeysCommand", () => {
  it("creates a supplied key without printing it", async () => {
    const out = capture();

    await runApiKeysCommand(
      { name: "create", role: "user", key: KEY },
      out.print,
    );

    expect(JSON.parse(storedAuth(KEY) ?? "null")).toEqual({ role: "user" });
    expect(out.lines.join("\n")).not.toContain(KEY);
    expect(out.lines.join("\n")).toContain(apiKeyFingerprint(KEY));
  });

  it("still overwrites the role of an existing key, as create always did", async () => {
    await runApiKeysCommand(
      { name: "create", role: "user", key: KEY },
      () => {},
    );
    await runApiKeysCommand(
      { name: "create", role: "admin", key: KEY },
      () => {},
    );

    expect(JSON.parse(storedAuth(KEY) ?? "null")).toEqual({ role: "admin" });
  });

  it("prints a generated key, since that is the only way to learn it", async () => {
    const out = capture();

    await runApiKeysCommand({ name: "create", role: "admin" }, out.print);

    const stored = [...stringData.keys()].map((k) =>
      k.slice(REDIS_KEY_PREFIX.length + 1),
    );
    expect(stored).toHaveLength(1);
    expect(out.lines.join("\n")).toContain(stored[0] as string);
  });

  it("deletes a key without printing it", async () => {
    await runApiKeysCommand(
      { name: "create", role: "user", key: KEY },
      () => {},
    );
    const out = capture();

    await runApiKeysCommand({ name: "delete", key: KEY }, out.print);

    expect(storedAuth(KEY)).toBeNull();
    expect(out.lines.join("\n")).not.toContain(KEY);
  });
});

describe("parseApiKeysCommand", () => {
  it("reads the argument order the boot command and the README use", () => {
    expect(parseApiKeysCommand(["create", "user", KEY])).toEqual({
      name: "create",
      role: "user",
      key: KEY,
    });
    expect(parseApiKeysCommand(["create"])).toEqual({
      name: "create",
      role: "user",
      key: undefined,
    });
    expect(parseApiKeysCommand(["delete", KEY])).toEqual({
      name: "delete",
      key: KEY,
    });
    expect(parseApiKeysCommand(["list"])).toEqual({ name: "list" });
  });

  it("rejects what it cannot run", () => {
    expect(parseApiKeysCommand([])).toBeNull();
    expect(parseApiKeysCommand(["delete"])).toBeNull();
    expect(parseApiKeysCommand(["rotate", KEY])).toBeNull();
  });
});

describe("bun manage-api-keys", () => {
  // The legacy Coolify command runs the package.json script through `bun run`,
  // which echoes the full command line, key included, unless the repo's
  // bunfig silences it. Only a real `bun run` from the repo root shows that.
  it("does not echo its arguments to the log", async () => {
    const root = path.resolve(import.meta.dir, "../..");
    const proc = Bun.spawn(["bun", "manage-api-keys", "nope", KEY], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        // An unknown command must not need Redis; a dead port proves it.
        REDIS_URL: "redis://127.0.0.1:1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 15_000);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);

    expect(`${stdout}${stderr}`).not.toContain(KEY);
    expect(stdout).toContain("Usage:");
    expect(code).toBe(0);
  }, 20_000);
});
