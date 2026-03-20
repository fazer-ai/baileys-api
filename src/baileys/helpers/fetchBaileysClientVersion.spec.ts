import { beforeEach, describe, expect, it } from "bun:test";
import { fetchLatestWaWebVersion } from "@whiskeysockets/baileys";
import config from "@/config";
import { fetchBaileysClientVersion } from "./fetchBaileysClientVersion";

const mockFetchLatest = fetchLatestWaWebVersion as ReturnType<
  typeof import("bun:test").mock
>;

describe("fetchBaileysClientVersion", () => {
  beforeEach(() => {
    mockFetchLatest.mockClear();
    config.baileys.overrideClientVersion = false;
    config.baileys.clientVersion = "default";
  });

  it("returns the latest version when no override is set", async () => {
    const version = await fetchBaileysClientVersion();
    expect(version).toEqual([2, 2400, 0]);
    expect(mockFetchLatest).toHaveBeenCalledTimes(1);
  });

  it("returns custom version when override is true and version is valid semver", async () => {
    config.baileys.overrideClientVersion = true;
    config.baileys.clientVersion = "2.3000.10";

    const version = await fetchBaileysClientVersion();
    expect(version).toEqual([2, 3000, 10]);
  });

  it("falls back to latest version when override is true but version is 'default'", async () => {
    config.baileys.overrideClientVersion = true;
    config.baileys.clientVersion = "default";

    const version = await fetchBaileysClientVersion();
    expect(version).toEqual([2, 2400, 0]);
  });

  it("falls back to latest version when override is true but version format is invalid", async () => {
    config.baileys.overrideClientVersion = true;
    config.baileys.clientVersion = "not-a-version";

    const version = await fetchBaileysClientVersion();
    expect(version).toEqual([2, 2400, 0]);
  });

  it("returns latest version and warns when clientVersion is set without override", async () => {
    config.baileys.overrideClientVersion = false;
    config.baileys.clientVersion = "2.3000.10";

    const version = await fetchBaileysClientVersion();
    // Should fall back to latest since override is not enabled
    expect(version).toEqual([2, 2400, 0]);
  });
});
