import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as registry from "@/cluster/instanceRegistry";
import * as leaseStore from "@/cluster/leaseStore";
import config from "@/config";
import { resolveMisdirectedRequest } from "./workerRouting";

const getLease = spyOn(leaseStore, "getLease");
const isInstanceAlive = spyOn(registry, "isInstanceAlive");

afterAll(() => {
  getLease.mockRestore();
  isInstanceAlive.mockRestore();
});

describe("resolveMisdirectedRequest", () => {
  beforeEach(() => {
    getLease.mockReset();
    isInstanceAlive.mockReset();
    getLease.mockResolvedValue(null);
    isInstanceAlive.mockResolvedValue(true);
    config.cluster.role = "worker";
  });

  afterAll(() => {
    config.cluster.role = "standalone";
  });

  it("returns the owner when the lease belongs to another live instance", async () => {
    // The lease is authoritative even if this worker still holds a socket:
    // during a handoff the new owner force-acquires before the previous
    // owner self-fences, and serving from the zombie socket would hide the
    // split-brain from the proxy. There is no local-socket short-circuit.
    getLease.mockResolvedValue({ owner: "peer-instance", epoch: 5 });

    expect(await resolveMisdirectedRequest("+5511999")).toBe("peer-instance");
    expect(getLease).toHaveBeenCalled();
  });

  it("serves locally when the lease owner is dead", async () => {
    // Advertising a dead owner via 421 sends the caller to an address that
    // cannot answer; the not-connected handling is the honest response while
    // failover claims the phone.
    getLease.mockResolvedValue({ owner: "peer-instance", epoch: 5 });
    isInstanceAlive.mockResolvedValue(false);

    expect(await resolveMisdirectedRequest("+5511999")).toBeNull();
  });

  it("serves locally when the lease is its own", async () => {
    getLease.mockResolvedValue({ owner: "test-instance", epoch: 5 });
    expect(await resolveMisdirectedRequest("+5511999")).toBeNull();
  });

  it("serves locally when there is no lease", async () => {
    expect(await resolveMisdirectedRequest("+5511999")).toBeNull();
  });

  it("serves locally when the lease cannot be read", async () => {
    // Bouncing 421s with no routable owner would loop at the proxy; local
    // not-connected handling degrades better.
    getLease.mockRejectedValue(new Error("redis down"));
    expect(await resolveMisdirectedRequest("+5511999")).toBeNull();
  });

  it("never misdirects outside worker role", async () => {
    config.cluster.role = "standalone";
    getLease.mockResolvedValue({ owner: "peer-instance", epoch: 5 });

    expect(await resolveMisdirectedRequest("+5511999")).toBeNull();
  });
});
