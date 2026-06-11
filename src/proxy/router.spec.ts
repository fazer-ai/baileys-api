import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import * as instanceRegistry from "@/cluster/instanceRegistry";
import * as leaseStore from "@/cluster/leaseStore";
import config from "@/config";
import redis from "@/lib/redis";
import { invalidateTarget } from "@/proxy/routeCache";
import {
  fanOutToAllInstances,
  forwardByPhone,
  forwardMediaRequest,
} from "@/proxy/router";

const getLease = spyOn(leaseStore, "getLease");
const getInstance = spyOn(instanceRegistry, "getInstance");
const listLiveInstances = spyOn(instanceRegistry, "listLiveInstances");

afterAll(() => {
  getLease.mockRestore();
  getInstance.mockRestore();
  listLiveInstances.mockRestore();
});

const PHONE = "+5511999999999";
const originalFetch = globalThis.fetch;
const originalMaxBodyBytes = config.proxy.maxBodyBytes;

function getRedisStringData() {
  return (redis as unknown as { __stringData: Map<string, string> })
    .__stringData;
}

interface FetchCall {
  url: string;
  method: string;
  body: string | null;
}

let fetchCalls: FetchCall[] = [];
let fetchResponder: (url: string) => Response | Promise<Response>;

const instanceInfo = (
  id: string,
  overrides?: Partial<instanceRegistry.InstanceInfo>,
) => ({
  instanceId: id,
  baseUrl: `http://${id}:3025`,
  connectionCount: 0,
  draining: false,
  startedAt: 0,
  ...overrides,
});

function makeRequest(path: string, method = "GET", body?: string): Request {
  return new Request(`http://proxy:3025${path}`, {
    method,
    body,
    headers: { "x-api-key": "key", "content-type": "application/json" },
  });
}

describe("proxy router", () => {
  beforeEach(() => {
    getLease.mockReset();
    getInstance.mockReset();
    listLiveInstances.mockReset();
    getLease.mockResolvedValue(null);
    getInstance.mockResolvedValue(null);
    listLiveInstances.mockResolvedValue([]);
    invalidateTarget(PHONE);
    getRedisStringData().clear();

    fetchCalls = [];
    fetchResponder = () => new Response("ok", { status: 200 });
    globalThis.fetch = mock(
      async (url: string | URL | Request, init?: RequestInit) => {
        fetchCalls.push({
          url: url.toString(),
          method: init?.method ?? "GET",
          body:
            typeof init?.body === "string"
              ? init.body
              : init?.body
                ? Buffer.from(init.body as ArrayBuffer).toString()
                : null,
        });
        return fetchResponder(url.toString());
      },
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    config.proxy.maxBodyBytes = originalMaxBodyBytes;
  });

  describe("#forwardByPhone", () => {
    it("forwards to the lease owner, preserving path, query and body", async () => {
      getLease.mockResolvedValue({ owner: "worker-1", epoch: 1 });
      getInstance.mockResolvedValue(instanceInfo("worker-1"));

      const response = await forwardByPhone(
        PHONE,
        makeRequest(
          `/connections/${encodeURIComponent(PHONE)}/send-message?x=1`,
          "POST",
          '{"jid":"a"}',
        ),
      );

      expect(response.status).toBe(200);
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toBe(
        `http://worker-1:3025/connections/${encodeURIComponent(PHONE)}/send-message?x=1`,
      );
      expect(fetchCalls[0].body).toBe('{"jid":"a"}');
    });

    it("caches the resolved route for subsequent requests", async () => {
      getLease.mockResolvedValue({ owner: "worker-1", epoch: 1 });
      getInstance.mockResolvedValue(instanceInfo("worker-1"));
      const path = `/connections/${encodeURIComponent(PHONE)}/send-message`;

      await forwardByPhone(PHONE, makeRequest(path, "POST", "{}"));
      await forwardByPhone(PHONE, makeRequest(path, "POST", "{}"));

      expect(getLease).toHaveBeenCalledTimes(1);
      expect(fetchCalls).toHaveLength(2);
    });

    it("returns 404 for an unowned phone on non-takeover routes", async () => {
      const response = await forwardByPhone(
        PHONE,
        makeRequest(
          `/connections/${encodeURIComponent(PHONE)}/send-message`,
          "POST",
          "{}",
        ),
      );

      expect(response.status).toBe(404);
      expect(fetchCalls).toHaveLength(0);
    });

    it("rejects unroutable requests before buffering the body", async () => {
      // An unowned phone with an oversized body must get the routing 404,
      // not a 413 from a body that should never have been read.
      config.proxy.maxBodyBytes = 8;

      const response = await forwardByPhone(
        PHONE,
        makeRequest(
          `/connections/${encodeURIComponent(PHONE)}/send-message`,
          "POST",
          "123456789",
        ),
      );

      expect(response.status).toBe(404);
    });

    it("places a new connection on the least loaded live worker", async () => {
      listLiveInstances.mockResolvedValue([
        instanceInfo("worker-1", { connectionCount: 10 }),
        instanceInfo("worker-2", { connectionCount: 3 }),
        instanceInfo("worker-3", { connectionCount: 1, draining: true }),
      ]);

      const response = await forwardByPhone(
        PHONE,
        makeRequest(`/connections/${encodeURIComponent(PHONE)}`, "POST", "{}"),
      );

      expect(response.status).toBe(200);
      // worker-3 is draining; worker-2 has the least load among eligible.
      expect(fetchCalls[0].url.startsWith("http://worker-2:3025")).toBe(true);
    });

    it("returns 503 with retry-after when the owner stopped heartbeating", async () => {
      // Lease alive, instance gone: crashed owner, failover still pending.
      getLease.mockResolvedValue({ owner: "worker-dead", epoch: 1 });
      getInstance.mockResolvedValue(null);

      const response = await forwardByPhone(
        PHONE,
        makeRequest(
          `/connections/${encodeURIComponent(PHONE)}/send-message`,
          "POST",
          "{}",
        ),
      );

      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
    });

    it("re-routes once when the worker answers 421 with the real owner", async () => {
      getLease.mockResolvedValue({ owner: "worker-1", epoch: 1 });
      getInstance.mockImplementation(async (id: string) =>
        id === "worker-1" ? instanceInfo("worker-1") : instanceInfo("worker-2"),
      );
      fetchResponder = (url) =>
        url.startsWith("http://worker-1")
          ? new Response("misdirected", {
              status: 421,
              headers: { "x-baileys-owner": "worker-2" },
            })
          : new Response("ok", { status: 200 });

      const response = await forwardByPhone(
        PHONE,
        makeRequest(
          `/connections/${encodeURIComponent(PHONE)}/send-message`,
          "POST",
          '{"jid":"a"}',
        ),
      );

      expect(response.status).toBe(200);
      expect(fetchCalls).toHaveLength(2);
      expect(fetchCalls[1].url.startsWith("http://worker-2:3025")).toBe(true);
      // The buffered body is replayed on the second hop.
      expect(fetchCalls[1].body).toBe('{"jid":"a"}');
    });

    it("gives up with 503 when the second hop is misdirected too", async () => {
      // Ownership in flux (failover/rebalance mid-flight): bouncing further
      // would loop at the proxy — hand the retry to the client.
      getLease.mockResolvedValue({ owner: "worker-1", epoch: 1 });
      getInstance.mockImplementation(async (id: string) => instanceInfo(id));
      fetchResponder = () =>
        new Response("misdirected", {
          status: 421,
          headers: { "x-baileys-owner": "worker-2" },
        });

      const response = await forwardByPhone(
        PHONE,
        makeRequest(
          `/connections/${encodeURIComponent(PHONE)}/send-message`,
          "POST",
          "{}",
        ),
      );

      expect(response.status).toBe(503);
      expect(fetchCalls).toHaveLength(2);
    });

    it("maps a dead-target fetch failure to 503 and a live-but-slow one to 504", async () => {
      getLease.mockResolvedValue({ owner: "worker-1", epoch: 1 });
      getInstance.mockResolvedValueOnce(instanceInfo("worker-1"));
      fetchResponder = () => {
        throw new Error("ECONNREFUSED");
      };

      // After the failure the router re-checks the registry: gone → 503.
      getInstance.mockResolvedValueOnce(null);
      const dead = await forwardByPhone(
        PHONE,
        makeRequest(
          `/connections/${encodeURIComponent(PHONE)}/send-message`,
          "POST",
          "{}",
        ),
      );
      expect(dead.status).toBe(503);

      // Still registered → 504.
      invalidateTarget(PHONE);
      getInstance.mockResolvedValueOnce(instanceInfo("worker-1"));
      getInstance.mockResolvedValueOnce(instanceInfo("worker-1"));
      const slow = await forwardByPhone(
        PHONE,
        makeRequest(
          `/connections/${encodeURIComponent(PHONE)}/send-message`,
          "POST",
          "{}",
        ),
      );
      expect(slow.status).toBe(504);
    });
  });

  describe("#forwardMediaRequest", () => {
    it("routes to the instance that holds the file", async () => {
      getRedisStringData().set("@baileys-api:media-owner:MSG123", "worker-2");
      getInstance.mockResolvedValue(instanceInfo("worker-2"));

      const response = await forwardMediaRequest(
        "MSG123",
        makeRequest("/media/MSG123"),
      );

      expect(response.status).toBe(200);
      expect(fetchCalls[0].url).toBe("http://worker-2:3025/media/MSG123");
    });

    it("returns 404 when no owner is recorded", async () => {
      const response = await forwardMediaRequest(
        "MSG123",
        makeRequest("/media/MSG123"),
      );
      expect(response.status).toBe(404);
      expect(fetchCalls).toHaveLength(0);
    });

    it("returns 404 when the owner died (file is gone with its disk)", async () => {
      getRedisStringData().set(
        "@baileys-api:media-owner:MSG123",
        "worker-dead",
      );

      const response = await forwardMediaRequest(
        "MSG123",
        makeRequest("/media/MSG123"),
      );
      expect(response.status).toBe(404);
    });

    it("maps a forward failure to 404 when the owner deregistered mid-request", async () => {
      getRedisStringData().set("@baileys-api:media-owner:MSG123", "worker-2");
      // Alive at resolution time, gone at the post-failure re-check.
      getInstance.mockResolvedValueOnce(instanceInfo("worker-2"));
      getInstance.mockResolvedValueOnce(null);
      fetchResponder = () => {
        throw new Error("ECONNREFUSED");
      };

      const response = await forwardMediaRequest(
        "MSG123",
        makeRequest("/media/MSG123"),
      );
      expect(response.status).toBe(404);
    });

    it("maps a forward failure to 504 when the owner is still registered", async () => {
      getRedisStringData().set("@baileys-api:media-owner:MSG123", "worker-2");
      getInstance.mockResolvedValue(instanceInfo("worker-2"));
      fetchResponder = () => {
        throw new Error("timeout");
      };

      const response = await forwardMediaRequest(
        "MSG123",
        makeRequest("/media/MSG123"),
      );
      expect(response.status).toBe(504);
    });
  });

  describe("#fanOutToAllInstances", () => {
    it("forwards to every live instance and aggregates statuses", async () => {
      listLiveInstances.mockResolvedValue([
        instanceInfo("worker-1"),
        instanceInfo("worker-2"),
      ]);

      const response = await fanOutToAllInstances(
        makeRequest("/admin/connections/logout-all", "POST"),
      );

      expect(fetchCalls).toHaveLength(2);
      const payload = (await response.json()) as {
        results: Array<{ instanceId: string; status: number }>;
      };
      expect(payload.results).toEqual([
        { instanceId: "worker-1", status: 200 },
        { instanceId: "worker-2", status: 200 },
      ]);
    });
  });
});
