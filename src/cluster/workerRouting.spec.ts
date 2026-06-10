import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as leaseStore from "@/cluster/leaseStore";
import config from "@/config";
import { resolveMisdirectedRequest } from "./workerRouting";

const getLease = spyOn(leaseStore, "getLease");

afterAll(() => {
  getLease.mockRestore();
});

describe("resolveMisdirectedRequest", () => {
  beforeEach(() => {
    getLease.mockReset();
    getLease.mockResolvedValue(null);
    config.cluster.role = "worker";
  });

  afterAll(() => {
    config.cluster.role = "standalone";
  });

  it("returns the owner when the lease belongs to another instance", async () => {
    getLease.mockResolvedValue({ owner: "peer-instance", epoch: 5 });

    expect(await resolveMisdirectedRequest("+5511999", false)).toBe(
      "peer-instance",
    );
  });

  it("serves locally when this instance holds the connection", async () => {
    // The socket and the lease live together; a local connection wins even
    // without consulting Redis.
    expect(await resolveMisdirectedRequest("+5511999", true)).toBeNull();
    expect(getLease).not.toHaveBeenCalled();
  });

  it("serves locally when the lease is its own", async () => {
    getLease.mockResolvedValue({ owner: "test-instance", epoch: 5 });
    expect(await resolveMisdirectedRequest("+5511999", false)).toBeNull();
  });

  it("serves locally when there is no lease", async () => {
    expect(await resolveMisdirectedRequest("+5511999", false)).toBeNull();
  });

  it("serves locally when the lease cannot be read", async () => {
    // Bouncing 421s with no routable owner would loop at the proxy; local
    // not-connected handling degrades better.
    getLease.mockRejectedValue(new Error("redis down"));
    expect(await resolveMisdirectedRequest("+5511999", false)).toBeNull();
  });

  it("never misdirects outside worker role", async () => {
    config.cluster.role = "standalone";
    getLease.mockResolvedValue({ owner: "peer-instance", epoch: 5 });

    expect(await resolveMisdirectedRequest("+5511999", false)).toBeNull();
  });
});
