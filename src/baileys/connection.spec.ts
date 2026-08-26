import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  setSystemTime,
  spyOn,
} from "bun:test";

// Track fetch calls for webhook tests
const fetchCalls: Array<{ url: string; body: string }> = [];
const originalFetch = globalThis.fetch;

import * as baileysModule from "@whiskeysockets/baileys";
import { WAMessageStatus } from "@whiskeysockets/baileys";
import { preprocessAudio } from "@/baileys/helpers/preprocessAudio";
import { clusterKeys } from "@/cluster/keys";
import * as sendStallStore from "@/cluster/sendStallStore";
import config from "@/config";
import { asyncSleep } from "@/helpers/asyncSleep";
import { OperationTimeoutError } from "@/helpers/withTimeout";
import redis from "@/lib/redis";
import {
  BaileysConnection,
  BaileysNotConnectedError,
  BaileysSendStalledError,
} from "./connection";

const mockSocket = (baileysModule as any).__mockSocket;
const mockEventHandlers = (baileysModule as any).__mockEventHandlers;

describe("BaileysConnection", () => {
  let connection: BaileysConnection;
  const defaultOptions = {
    webhookUrl: "https://example.com/webhook",
    webhookVerifyToken: "test-token",
  };

  beforeEach(() => {
    connection = new BaileysConnection("+5511999999999", defaultOptions);
    mockEventHandlers.clear();
    mockSocket.ev.on.mockClear();
    mockSocket.logout.mockClear();
    mockSocket.sendMessage.mockClear();
    mockSocket.sendPresenceUpdate.mockClear();
    mockSocket.readMessages.mockClear();
    mockSocket.chatModify.mockClear();
    mockSocket.fetchMessageHistory.mockClear();
    mockSocket.sendReceipts.mockClear();
    mockSocket.profilePictureUrl.mockClear();
    mockSocket.ev.removeAllListeners.mockClear();
    mockSocket.onWhatsApp.mockClear();
    mockSocket.groupMetadata.mockClear();
    mockSocket.groupParticipantsUpdate.mockClear();
    mockSocket.groupCreate.mockClear();
    mockSocket.groupLeave.mockClear();
    mockSocket.groupUpdateSubject.mockClear();
    mockSocket.groupUpdateDescription.mockClear();
    mockSocket.groupInviteCode.mockClear();
    mockSocket.groupRevokeInvite.mockClear();
    mockSocket.groupAcceptInvite.mockClear();
    mockSocket.groupSettingUpdate.mockClear();
    mockSocket.groupToggleEphemeral.mockClear();
    mockSocket.groupFetchAllParticipating.mockClear();
    mockSocket.signalRepository.lidMapping.getPNForLID.mockClear();
    mockSocket.signalRepository.lidMapping.getLIDForPN.mockClear();
    mockSocket.signalRepository.lidMapping.getPNsForLIDs.mockClear();

    // Clear redis state
    (redis as any).__hashData.clear();
    (redis as any).__stringData.clear();
    (redis as any).__multiCommands.length = 0;
    (redis.hSet as any).mockClear();
    (redis.hGet as any).mockClear();
    (redis.del as any).mockClear();
    (redis.keys as any).mockClear();
    (redis.multi as any).mockClear();

    // Reset config
    config.webhook.retryPolicy.maxRetries = 0;

    fetchCalls.length = 0;

    globalThis.fetch = mock(
      async (url: string | URL | Request, init?: RequestInit) => {
        fetchCalls.push({
          url: url.toString(),
          body: init?.body as string,
        });
        return new Response("ok", { status: 200 });
      },
    ) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("constructor", () => {
    it("sets default values for optional parameters", () => {
      const conn = new BaileysConnection("+5511999", {
        webhookUrl: "https://hook.com",
        webhookVerifyToken: "token",
      });
      expect(conn.apiKeyHash).toBeNull();
    });

    it("stores the apiKeyHash", () => {
      const conn = new BaileysConnection("+5511999", {
        webhookUrl: "https://hook.com",
        webhookVerifyToken: "token",
        apiKeyHash: "hash-123",
      });
      expect(conn.apiKeyHash).toBe("hash-123");
    });
  });

  describe("#connect", () => {
    it("creates a socket and registers event listeners", async () => {
      await connection.connect();
      expect(mockSocket.ev.on).toHaveBeenCalled();
      expect(mockEventHandlers.has("connection.update")).toBe(true);
      expect(mockEventHandlers.has("creds.update")).toBe(true);
      expect(mockEventHandlers.has("messages.upsert")).toBe(true);
    });

    it("does nothing if already connected", async () => {
      await connection.connect();
      const callCount = mockSocket.ev.on.mock.calls.length;
      await connection.connect();
      // Should not register new listeners
      expect(mockSocket.ev.on.mock.calls.length).toBe(callCount);
    });
  });

  describe("#logout", () => {
    it("completes without throwing even when not connected (error is caught internally)", async () => {
      // logout() catches safeSocket() errors internally
      await connection.logout();
    });

    it("calls socket logout and clears state", async () => {
      const authKey = "@baileys-api:connections:+5511999999999:authState";
      await connection.connect();
      expect((redis as any).__hashData.has(authKey)).toBe(true);

      await connection.logout();

      expect(mockSocket.logout).toHaveBeenCalledTimes(1);
      // clearAuthState goes through the owner-fenced clear script now.
      expect((redis as any).__hashData.has(authKey)).toBe(false);
    });

    it("marks the connection discarded before the logout RPC so a mid-logout close event cannot resurrect the socket", async () => {
      // Park `socket.logout()` on a deferred promise. While the logout RPC
      // is in flight, fire a non-loggedOut close (e.g. another device
      // grabbed the session) and assert that handleConnectionUpdate does
      // NOT try to reconnect — i.e. makeWASocket is not invoked.
      await connection.connect();
      const handler = mockEventHandlers.get("connection.update")!;
      const baileys = (await import("@whiskeysockets/baileys")) as any;
      const makeSocket = baileys.default as ReturnType<typeof mock>;

      let releaseLogout: () => void = () => {};
      const logoutDeferred = new Promise<void>((res) => {
        releaseLogout = res;
      });
      mockSocket.logout.mockImplementationOnce(() => logoutDeferred);

      const logoutPromise = connection.logout();
      // Yield until logout is parked on the deferred RPC.
      while (mockSocket.logout.mock.calls.length === 0) {
        await new Promise((r) => setImmediate(r));
      }

      const callsBefore = makeSocket.mock.calls.length;

      // Simulate a connectionReplaced close arriving mid-logout.
      await handler({
        connection: "close" as const,
        lastDisconnect: {
          error: {
            output: {
              statusCode: 440,
              payload: {
                statusCode: 440,
                error: "Unknown",
                message: "Stream Errored (conflict)",
              },
            },
            message: "Stream Errored (conflict)",
          },
        },
      });

      releaseLogout();
      await logoutPromise;

      // The mid-logout close must NOT have triggered a reconnect.
      expect(makeSocket.mock.calls.length).toBe(callsBefore);
    });
  });

  describe("wrong phone number", () => {
    const wrongUserId = "5511888888888:0@s.whatsapp.net";

    it("routes teardown through requestLogout when the handler wired one", async () => {
      const requestLogout = mock(() => {});
      const conn = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        requestLogout,
      });
      await conn.connect();
      const handler = mockEventHandlers.get("connection.update")!;
      // Socket opened paired with a DIFFERENT number than the registered one.
      mockSocket.user = { id: wrongUserId };
      mockSocket.logout.mockClear();

      await handler({ connection: "open" });

      // The wrong-phone webhook fired...
      expect(
        fetchCalls.some((c) =>
          c.body?.includes('"error":"wrong_phone_number"'),
        ),
      ).toBe(true);
      // ...and teardown was delegated to the handler, NOT a direct socket logout.
      expect(requestLogout).toHaveBeenCalledTimes(1);
      expect(mockSocket.logout).not.toHaveBeenCalled();
    });

    it("falls back to a direct logout when no requestLogout is wired", async () => {
      await connection.connect();
      const handler = mockEventHandlers.get("connection.update")!;
      mockSocket.user = { id: wrongUserId };
      mockSocket.logout.mockClear();

      await handler({ connection: "open" });

      expect(
        fetchCalls.some((c) =>
          c.body?.includes('"error":"wrong_phone_number"'),
        ),
      ).toBe(true);
      // No handler wired -> direct connection.logout() -> socket.logout().
      expect(mockSocket.logout).toHaveBeenCalledTimes(1);
    });
  });

  describe("#discard", () => {
    it("prevents subsequent connect() from opening a new socket", async () => {
      const makeSocket = ((await import("@whiskeysockets/baileys")) as any)
        .default as ReturnType<typeof mock>;
      const callsBefore = makeSocket.mock.calls.length;

      connection.discard();
      await connection.connect();

      expect(makeSocket.mock.calls.length).toBe(callsBefore);
    });

    it("makes handleConnectionUpdate a no-op so no reconnecting webhook fires after discard", async () => {
      // `socket.end()` emits a final connection.update {close} synchronously.
      // Without the early guard in handleConnectionUpdate, the handler would
      // dispatch a `reconnecting` webhook for a connection that is gone.
      await connection.connect();
      const handler = mockEventHandlers.get("connection.update")!;
      fetchCalls.length = 0;

      connection.discard();

      // Simulate the close event that end() emits.
      await handler({
        connection: "close" as const,
        lastDisconnect: {
          error: { output: { statusCode: 500, payload: {} }, message: "x" },
        },
      });

      const reconnectingHits = fetchCalls.filter((c) =>
        c.body?.includes('"connection":"reconnecting"'),
      );
      expect(reconnectingHits.length).toBe(0);
    });

    it("re-checks isDiscarded after each await in connect()", async () => {
      // discard() may run while connect() is awaiting useRedisAuthState or
      // the version fetch. Without per-await guards, the stale instance
      // would still call makeWASocket and race the replacement. We pin the
      // window open with a deferred fetchLatestWaWebVersion: connect()
      // parks on the version fetch, we discard, then release — the second
      // guard must short-circuit before makeWASocket.
      const baileys = (await import("@whiskeysockets/baileys")) as any;
      const makeSocket = baileys.default as ReturnType<typeof mock>;
      const fetchVersion = baileys.fetchLatestWaWebVersion as ReturnType<
        typeof mock
      >;

      let releaseFetch: () => void = () => {};
      const fetchDeferred = new Promise<{
        version: [number, number, number];
      }>((res) => {
        releaseFetch = () => res({ version: [2, 2400, 0] });
      });
      fetchVersion.mockImplementationOnce(() => fetchDeferred);

      const callsBefore = makeSocket.mock.calls.length;
      const connectPromise = connection.connect();

      // Yield until connect() is parked on the deferred fetch. Polling
      // beats a fixed setImmediate count because it doesn't bake the
      // number of intermediate awaits into the test.
      while (fetchVersion.mock.calls.length === 0) {
        await new Promise((r) => setImmediate(r));
      }
      // Socket can't have been created yet — connect() is awaiting the fetch.
      expect(makeSocket.mock.calls.length).toBe(callsBefore);

      connection.discard();
      releaseFetch();
      await connectPromise;

      // After resuming, the post-fetch isDiscarded guard must bail before
      // makeWASocket runs.
      expect(makeSocket.mock.calls.length).toBe(callsBefore);
    });

    it("aborts the post-backoff reconnect after connectionReplaced", async () => {
      // The exact race that motivated discard(): after the 5th
      // connectionReplaced in the window, BaileysConnection sleeps for the
      // backoff. If the handler discards during that sleep (because a POST
      // drove it into the recovery path and spawned a replacement), the
      // post-sleep this.connect() must NOT bring up a second socket.
      // We pin the window open with a deferred asyncSleep so the discard
      // happens strictly inside the sleep, not after it.
      await connection.connect();
      const handler = mockEventHandlers.get("connection.update")!;
      const conflictClosePayload = {
        connection: "close" as const,
        lastDisconnect: {
          error: {
            output: {
              statusCode: 440,
              payload: {
                statusCode: 440,
                error: "Unknown",
                message: "Stream Errored (conflict)",
              },
            },
            message: "Stream Errored (conflict)",
          },
        },
      };

      // First 4 closes set up the threshold. Each schedules a
      // fire-and-forget this.connect(); drain those before snapshotting.
      for (let i = 0; i < 4; i++) {
        await handler(conflictClosePayload);
      }
      const baileys = (await import("@whiskeysockets/baileys")) as any;
      const makeSocket = baileys.default as ReturnType<typeof mock>;
      const sleepMock = asyncSleep as ReturnType<typeof mock>;
      // Settle any pending fire-and-forget reconnects so callsBefore is
      // stable. Poll until two consecutive ticks show no growth.
      let prev = -1;
      while (prev !== makeSocket.mock.calls.length) {
        prev = makeSocket.mock.calls.length;
        await new Promise((r) => setImmediate(r));
      }

      // Arm the 5th close to park on asyncSleep until we release it.
      let releaseSleep: () => void = () => {};
      const sleepDeferred = new Promise<void>((res) => {
        releaseSleep = res;
      });
      const sleepCallsBefore = sleepMock.mock.calls.length;
      sleepMock.mockImplementationOnce(() => sleepDeferred);

      const fifthClose = handler(conflictClosePayload);
      // Yield until handleConnectionUpdate has entered the deferred sleep.
      while (sleepMock.mock.calls.length === sleepCallsBefore) {
        await new Promise((r) => setImmediate(r));
      }

      const callsBefore = makeSocket.mock.calls.length;

      // Discard strictly inside the backoff window.
      connection.discard();

      releaseSleep();
      await fifthClose;
      // Drain the fire-and-forget this.connect() the handler queued.
      let stable = -1;
      while (stable !== makeSocket.mock.calls.length) {
        stable = makeSocket.mock.calls.length;
        await new Promise((r) => setImmediate(r));
      }

      // Post-backoff this.connect() must have honored isDiscarded.
      expect(makeSocket.mock.calls.length).toBe(callsBefore);
    });
  });

  describe("connectionReplaced lease gate", () => {
    const leaseKey = "@baileys-api:cluster:lease:+5511999999999";
    const conflictClosePayload = {
      connection: "close" as const,
      lastDisconnect: {
        error: {
          output: {
            statusCode: 440,
            payload: {
              statusCode: 440,
              error: "Unknown",
              message: "Stream Errored (conflict)",
            },
          },
          message: "Stream Errored (conflict)",
        },
      },
    };

    async function settle(makeSocket: ReturnType<typeof mock>) {
      let prev = -1;
      while (prev !== makeSocket.mock.calls.length) {
        prev = makeSocket.mock.calls.length;
        await new Promise((r) => setImmediate(r));
      }
    }

    it("yields instead of reconnecting when the lease is owned by another instance", async () => {
      await connection.connect();
      const handler = mockEventHandlers.get("connection.update")!;
      const makeSocket = ((await import("@whiskeysockets/baileys")) as any)
        .default as ReturnType<typeof mock>;
      await settle(makeSocket);
      const callsBefore = makeSocket.mock.calls.length;

      (redis as any).__stringData.set(
        leaseKey,
        JSON.stringify({ owner: "other-instance", epoch: 7 }),
      );
      fetchCalls.length = 0;

      await handler(conflictClosePayload);
      await settle(makeSocket);

      // No socket resurrection: the replacement is the legitimate owner.
      expect(makeSocket.mock.calls.length).toBe(callsBefore);
      // And no reconnecting webhook — the new owner narrates from here on.
      const reconnectingHits = fetchCalls.filter((c) =>
        c.body?.includes('"connection":"reconnecting"'),
      );
      expect(reconnectingHits.length).toBe(0);
    });

    it("keeps the reconnect behavior when the lease is its own", async () => {
      await connection.connect();
      const handler = mockEventHandlers.get("connection.update")!;
      const makeSocket = ((await import("@whiskeysockets/baileys")) as any)
        .default as ReturnType<typeof mock>;
      await settle(makeSocket);
      const callsBefore = makeSocket.mock.calls.length;

      // instanceId resolves to "test-instance" via the preload config mock.
      (redis as any).__stringData.set(
        leaseKey,
        JSON.stringify({ owner: "test-instance", epoch: 7 }),
      );

      await handler(conflictClosePayload);
      await settle(makeSocket);

      expect(makeSocket.mock.calls.length).toBe(callsBefore + 1);
    });

    it("keeps the reconnect behavior when there is no lease", async () => {
      await connection.connect();
      const handler = mockEventHandlers.get("connection.update")!;
      const makeSocket = ((await import("@whiskeysockets/baileys")) as any)
        .default as ReturnType<typeof mock>;
      await settle(makeSocket);
      const callsBefore = makeSocket.mock.calls.length;

      await handler(conflictClosePayload);
      await settle(makeSocket);

      expect(makeSocket.mock.calls.length).toBe(callsBefore + 1);
    });

    it("keeps the reconnect behavior when the lease read fails", async () => {
      // A Redis outage must not self-fence a healthy socket: an unverifiable
      // lease falls back to the plain reconnect/backoff path.
      await connection.connect();
      const handler = mockEventHandlers.get("connection.update")!;
      const makeSocket = ((await import("@whiskeysockets/baileys")) as any)
        .default as ReturnType<typeof mock>;
      await settle(makeSocket);
      const callsBefore = makeSocket.mock.calls.length;

      (redis.get as any).mockImplementationOnce(async () => {
        throw new Error("redis down");
      });

      await handler(conflictClosePayload);
      await settle(makeSocket);

      expect(makeSocket.mock.calls.length).toBe(callsBefore + 1);
    });
  });

  describe("lease epoch on connection.update", () => {
    const leaseKey = "@baileys-api:cluster:lease:+5511999999999";

    it("stamps connection.update payloads with the epoch threaded in from the lease claim", async () => {
      // The epoch comes exclusively from the coordinator's claim (options),
      // never from a Redis read: a re-read mid-connect could observe a
      // successor's lease and stamp the wrong epoch onto our webhooks. The
      // store deliberately disagrees (epoch 9) to prove there is no re-read.
      (redis as any).__stringData.set(
        leaseKey,
        JSON.stringify({ owner: "test-instance", epoch: 9 }),
      );
      const conn = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        leaseEpoch: 7,
      });
      await conn.connect();
      const handler = mockEventHandlers.get("connection.update")!;
      fetchCalls.length = 0;

      await handler({ isNewLogin: true });

      while (!fetchCalls.some((c) => c.body?.includes('"epoch":7'))) {
        await new Promise((r) => setImmediate(r));
      }
      expect(fetchCalls.some((c) => c.body?.includes('"epoch":9'))).toBe(false);
      conn.discard();
    });

    it("refreshes the pinned epoch when updateOptions carries a newer one", async () => {
      // A reused connection re-leased under a newer epoch (force-acquire on
      // POST /connections) must not keep stamping the old epoch — the client
      // would discard its webhooks as stale.
      const conn = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        leaseEpoch: 7,
      });
      await conn.connect();
      const handler = mockEventHandlers.get("connection.update")!;
      await conn.updateOptions({ ...defaultOptions, leaseEpoch: 9 });
      fetchCalls.length = 0;

      await handler({ isNewLogin: true });

      while (!fetchCalls.some((c) => c.body?.includes('"epoch":9'))) {
        await new Promise((r) => setImmediate(r));
      }
      conn.discard();
    });

    it("refuses an epoch that would go backwards", async () => {
      // Two explicit operations racing. The one that acquired the OLDER epoch can
      // still be parked before the handler when the newer one replaces the
      // socket, and it arrives here afterwards carrying its own. Taking it leaves
      // a live connection stamping events the client discards as stale while the
      // coordinator renews an epoch nobody publishes: the channel stops updating.
      const conn = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        leaseEpoch: 9,
      });
      await conn.connect();
      const handler = mockEventHandlers.get("connection.update")!;

      await conn.updateOptions({
        ...defaultOptions,
        webhookUrl: "https://reconfigured.example/hook",
        leaseEpoch: 7,
      });
      fetchCalls.length = 0;

      await handler({ isNewLogin: true });
      // A bounded wait, not the spin the sibling examples use: this one asserts
      // an epoch is ABSENT, and a regression that stamps 7 would hang a spin for
      // 9 instead of failing.
      await new Promise((r) => setTimeout(r, 10));

      expect(fetchCalls.some((c) => c.body?.includes('"epoch":9'))).toBe(true);
      expect(fetchCalls.some((c) => c.body?.includes('"epoch":7'))).toBe(false);
      // The rest of that operation still applied: it is a real reconfiguration,
      // just no longer the owner of record.
      expect(conn.currentOptions.webhookUrl).toBe(
        "https://reconfigured.example/hook",
      );
      conn.discard();
    });

    it("omits the epoch when none was provided", async () => {
      await connection.connect();
      const handler = mockEventHandlers.get("connection.update")!;
      fetchCalls.length = 0;

      await handler({ isNewLogin: true });

      while (
        !fetchCalls.some((c) => c.body?.includes('"connection":"reconnecting"'))
      ) {
        await new Promise((r) => setImmediate(r));
      }
      expect(fetchCalls.some((c) => c.body?.includes('"epoch"'))).toBe(false);
    });
  });

  describe("traffic tracking", () => {
    it("starts with no traffic recorded", async () => {
      await connection.connect();
      expect(connection.lastTrafficAt).toBeNull();
    });

    it("marks traffic on incoming messages", async () => {
      await connection.connect();
      const handler = mockEventHandlers.get("messages.upsert")!;

      await handler({ type: "notify", messages: [] });

      expect(connection.lastTrafficAt).not.toBeNull();
    });

    it("marks traffic on outgoing sends", async () => {
      await connection.connect();

      await connection.sendMessage("5511888@s.whatsapp.net", { text: "hi" });

      expect(connection.lastTrafficAt).not.toBeNull();
    });

    it("marks traffic on receipt updates", async () => {
      await connection.connect();
      const handler = mockEventHandlers.get("message-receipt.update")!;

      await handler([]);

      expect(connection.lastTrafficAt).not.toBeNull();
    });
  });

  describe("post-discard auth write guard", () => {
    const authKey = "@baileys-api:connections:+5511999999999:authState";

    it("persists creds while active", async () => {
      await connection.connect();
      const credsHandler = mockEventHandlers.get("creds.update")!;

      await credsHandler(undefined as never);

      const hash = (redis as any).__hashData.get(authKey);
      expect(hash?.get("creds")).toBeDefined();
    });

    it("stops persisting creds after discard", async () => {
      // A discarded socket may belong to an identity that is already live
      // elsewhere; its late creds.update must not clobber the shared state.
      await connection.connect();
      const credsHandler = mockEventHandlers.get("creds.update")!;

      connection.discard();
      await credsHandler(undefined as never);

      const hash = (redis as any).__hashData.get(authKey);
      expect(hash?.get("creds")).toBeUndefined();
    });

    it("stops persisting signal keys after discard", async () => {
      // guardedKeys wraps state.keys.set — the makeCacheableSignalKeyStore
      // mock is an identity passthrough, so the keys object handed to
      // makeWASocket IS the guarded wrapper.
      await connection.connect();
      const makeSocket = ((await import("@whiskeysockets/baileys")) as any)
        .default as ReturnType<typeof mock>;
      const [socketOptions] = makeSocket.mock.calls.at(-1) as [
        { auth: { keys: { set: (data: unknown) => Promise<void> } } },
      ];
      const guardedKeys = socketOptions.auth.keys;

      await guardedKeys.set({ "pre-key": { "1": { keyId: 1 } } });
      const hash = (redis as any).__hashData.get(authKey);
      expect(hash?.get("pre-key-1")).toBeDefined();

      connection.discard();
      await guardedKeys.set({ "pre-key": { "2": { keyId: 2 } } });
      expect(hash?.get("pre-key-2")).toBeUndefined();
    });
  });

  describe("reconnect loop abort", () => {
    // Each `isNewLogin` connection.update routes through handleReconnecting
    // and bumps reconnectCount. Past the threshold (>10) the connection must
    // give up WITHOUT clearing the Redis auth state: the destructive close()
    // used to DEL the shared authState hash, which in a multi-instance
    // setup wipes the identity out from under the legitimate owner and
    // forces a new QR scan.
    it("preserves auth state, notifies the webhook, and evicts itself past the reconnect threshold", async () => {
      let closeCalls = 0;
      const conn = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        onConnectionClose: () => {
          closeCalls += 1;
        },
      });
      await conn.connect();
      const handler = mockEventHandlers.get("connection.update")!;

      for (let i = 0; i < 11; i++) {
        await handler({ isNewLogin: true });
      }

      // Auth state preserved: no DEL of the authState hash.
      expect((redis.del as any).mock.calls.length).toBe(0);
      // Handler eviction fired exactly once.
      expect(closeCalls).toBe(1);

      // The structured error webhook must reach the client.
      while (
        !fetchCalls.some((c) =>
          c.body?.includes('"error":"reconnect_loop_detected"'),
        )
      ) {
        await new Promise((r) => setImmediate(r));
      }
    });

    it("records quarantine strikes with doubling backoff and reports them on the webhook", async () => {
      setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      try {
        const quarantineKey = "@baileys-api:cluster:quarantine:+5511999999999";
        const stringData = (redis as any).__stringData as Map<string, string>;

        await connection.connect();
        let handler = mockEventHandlers.get("connection.update")!;
        for (let i = 0; i < 11; i++) {
          await handler({ isNewLogin: true });
        }

        // The isNewLogin path fires handleReconnecting without awaiting it,
        // so the strike lands asynchronously.
        while (!stringData.has(quarantineKey)) {
          await new Promise((r) => setImmediate(r));
        }
        let stored = JSON.parse(stringData.get(quarantineKey)!) as {
          strikes: number;
          nextRetryAt: number;
        };
        expect(stored.strikes).toBe(1);
        expect(stored.nextRetryAt).toBe(
          Date.parse("2026-01-01T00:00:00.000Z") + 60_000,
        );
        // The webhook advertises the quarantine so clients can render the
        // real state instead of a bare "try reconnecting".
        while (
          !fetchCalls.some(
            (c) =>
              c.body?.includes('"error":"reconnect_loop_detected"') &&
              c.body?.includes('"quarantine"') &&
              c.body?.includes('"strikes":1'),
          )
        ) {
          await new Promise((r) => setImmediate(r));
        }

        // A second full failed cycle doubles the backoff.
        connection = new BaileysConnection("+5511999999999", defaultOptions);
        await connection.connect();
        handler = mockEventHandlers.get("connection.update")!;
        for (let i = 0; i < 11; i++) {
          await handler({ isNewLogin: true });
        }
        while (
          (JSON.parse(stringData.get(quarantineKey)!) as { strikes: number })
            .strikes < 2
        ) {
          await new Promise((r) => setImmediate(r));
        }
        stored = JSON.parse(stringData.get(quarantineKey)!) as {
          strikes: number;
          nextRetryAt: number;
        };
        expect(stored.strikes).toBe(2);
        expect(stored.nextRetryAt).toBe(
          Date.parse("2026-01-01T00:00:00.000Z") + 120_000,
        );
      } finally {
        setSystemTime();
      }
    });

    it("clears quarantine when the connection opens", async () => {
      const quarantineKey = "@baileys-api:cluster:quarantine:+5511999999999";
      const stringData = (redis as any).__stringData as Map<string, string>;
      stringData.set(
        quarantineKey,
        JSON.stringify({ strikes: 3, nextRetryAt: Date.now() + 60_000 }),
      );

      await connection.connect();
      const handler = mockEventHandlers.get("connection.update")!;
      await handler({ connection: "open" });

      // clearQuarantine is fire-and-forget on the open path.
      while (stringData.has(quarantineKey)) {
        await new Promise((r) => setImmediate(r));
      }
      expect(stringData.has(quarantineKey)).toBe(false);
    });

    it("does not resurrect the socket via the post-close reconnect after aborting", async () => {
      await connection.connect();
      const handler = mockEventHandlers.get("connection.update")!;

      // Drive the count to the threshold with isNewLogin updates.
      for (let i = 0; i < 10; i++) {
        await handler({ isNewLogin: true });
      }

      const baileys = (await import("@whiskeysockets/baileys")) as any;
      const makeSocket = baileys.default as ReturnType<typeof mock>;
      // Settle any pending fire-and-forget reconnects before snapshotting.
      let prev = -1;
      while (prev !== makeSocket.mock.calls.length) {
        prev = makeSocket.mock.calls.length;
        await new Promise((r) => setImmediate(r));
      }
      const callsBefore = makeSocket.mock.calls.length;

      // The 11th increment arrives via a close event whose handler queues a
      // fire-and-forget this.connect() right after handleReconnecting —
      // abort() must have flagged the connection so that connect no-ops.
      await handler({
        connection: "close" as const,
        lastDisconnect: {
          error: { output: { statusCode: 500, payload: {} }, message: "x" },
        },
      });
      let stable = -1;
      while (stable !== makeSocket.mock.calls.length) {
        stable = makeSocket.mock.calls.length;
        await new Promise((r) => setImmediate(r));
      }

      expect(makeSocket.mock.calls.length).toBe(callsBefore);
      expect((redis.del as any).mock.calls.length).toBe(0);
    });
  });

  describe("import Noise candidate cycling", () => {
    // A just-imported session cycles through its seeded Noise candidates when it
    // closes before opening (only one candidate is the real key). That cycling
    // is a bounded iteration, NOT a reconnect loop, so it must not count against
    // the >10 reconnect-loop guard — otherwise a candidate list longer than the
    // threshold aborts before the winning candidate (here index 12) is reached,
    // and only a coordinator re-claim could resume it.
    it("does not trip the reconnect-loop guard while cycling candidates past the threshold", async () => {
      const authKey = "@baileys-api:connections:+5511999999999:authState";
      const candidates = Array.from({ length: 13 }, (_, i) => ({
        private: Buffer.from(`private-key-${i}`.padEnd(32, "0")).toString(
          "base64",
        ),
        public: Buffer.from(`public-key-${i}`.padEnd(32, "0")).toString(
          "base64",
        ),
      }));
      (redis as any).__hashData.set(
        authKey,
        new Map<string, string>([
          ["creds", JSON.stringify({})],
          ["import-candidates", JSON.stringify({ candidates, index: 0 })],
        ]),
      );

      await connection.connect();
      const handler = mockEventHandlers.get("connection.update")!;
      const baileys = (await import("@whiskeysockets/baileys")) as any;
      const makeSocket = baileys.default as ReturnType<typeof mock>;

      // Drive 12 close-before-open events → 12 candidate advances (cursor 0->12).
      // Without the guard reset in the candidate-advance branch, the 11th advance
      // would push reconnectCount past 10 and abort with reconnect_loop_detected.
      for (let i = 0; i < 12; i++) {
        await handler({
          connection: "close" as const,
          lastDisconnect: {
            error: { output: { statusCode: 500, payload: {} }, message: "x" },
          },
        });
        let stable = -1;
        while (stable !== makeSocket.mock.calls.length) {
          stable = makeSocket.mock.calls.length;
          await new Promise((r) => setImmediate(r));
        }
      }

      // The reconnect-loop guard must not have fired while cycling candidates.
      expect(
        fetchCalls.some((c) =>
          c.body?.includes('"error":"reconnect_loop_detected"'),
        ),
      ).toBe(false);
      // Auth state is preserved throughout (never destructively cleared).
      expect((redis.del as any).mock.calls.length).toBe(0);
      // The cursor advanced through every candidate we drove.
      const stored = JSON.parse(
        (redis as any).__hashData.get(authKey)!.get("import-candidates")!,
      ) as { index: number };
      expect(stored.index).toBe(12);
    });

    // advanceImportCandidate hits Redis on every reconnect, not just imports.
    // A transient Redis failure there must not strand the connection: the error
    // is swallowed and the normal reconnect proceeds.
    it("falls back to a normal reconnect when advanceImportCandidate throws", async () => {
      const authKey = "@baileys-api:connections:+5511999999999:authState";
      (redis as any).__hashData.set(
        authKey,
        new Map<string, string>([
          ["creds", JSON.stringify({})],
          [
            "import-candidates",
            JSON.stringify({
              candidates: [
                { private: "cA==", public: "cB==" },
                { private: "cC==", public: "cD==" },
              ],
              index: 0,
            }),
          ],
        ]),
      );

      await connection.connect();
      const handler = mockEventHandlers.get("connection.update")!;
      const baileys = (await import("@whiskeysockets/baileys")) as any;
      const makeSocket = baileys.default as ReturnType<typeof mock>;
      const socketsBefore = makeSocket.mock.calls.length;

      // The next hGet is the import-candidates read inside
      // advanceImportCandidate; make it blow up.
      (redis.hGet as any).mockImplementationOnce(() =>
        Promise.reject(new Error("redis down")),
      );

      await handler({
        connection: "close" as const,
        lastDisconnect: {
          error: { output: { statusCode: 500, payload: {} }, message: "x" },
        },
      });
      let stable = -1;
      while (stable !== makeSocket.mock.calls.length) {
        stable = makeSocket.mock.calls.length;
        await new Promise((r) => setImmediate(r));
      }

      // Despite the Redis failure, a normal reconnect still happened (a new
      // socket was created) rather than the connection being stranded.
      expect(makeSocket.mock.calls.length).toBeGreaterThan(socketsBefore);
      expect(
        fetchCalls.some((c) =>
          c.body?.includes('"error":"reconnect_loop_detected"'),
        ),
      ).toBe(false);
    });

    // A connectionReplaced kick is a legitimate takeover signal, not a wrong
    // -candidate one. A not-yet-open imported session must yield to the lease
    // owner instead of consuming a candidate and fighting the owner.
    it("does not cycle a candidate on connectionReplaced; yields to the lease owner", async () => {
      const authKey = "@baileys-api:connections:+5511999999999:authState";
      const leaseKey = "@baileys-api:cluster:lease:+5511999999999";
      const candidates = [
        { private: "cGE=", public: "cWE=" },
        { private: "cGI=", public: "cWI=" },
      ];
      (redis as any).__hashData.set(
        authKey,
        new Map<string, string>([
          ["creds", JSON.stringify({})],
          ["import-candidates", JSON.stringify({ candidates, index: 0 })],
        ]),
      );
      // Lease owned by a live peer → the replaced kick is a legitimate takeover.
      (redis as any).__stringData.set(
        leaseKey,
        JSON.stringify({ owner: "other-instance", epoch: 7 }),
      );

      await connection.connect();
      const handler = mockEventHandlers.get("connection.update")!;
      const makeSocket = ((await import("@whiskeysockets/baileys")) as any)
        .default as ReturnType<typeof mock>;
      let stable = -1;
      while (stable !== makeSocket.mock.calls.length) {
        stable = makeSocket.mock.calls.length;
        await new Promise((r) => setImmediate(r));
      }
      const callsBefore = makeSocket.mock.calls.length;

      await handler({
        connection: "close" as const,
        lastDisconnect: {
          error: {
            output: { statusCode: 440, payload: {} },
            message: "Stream Errored (conflict)",
          },
        },
      });
      stable = -1;
      while (stable !== makeSocket.mock.calls.length) {
        stable = makeSocket.mock.calls.length;
        await new Promise((r) => setImmediate(r));
      }

      // Yielded: no new socket spawned, and the candidate cursor was untouched.
      expect(makeSocket.mock.calls.length).toBe(callsBefore);
      const stored = JSON.parse(
        (redis as any).__hashData.get(authKey)!.get("import-candidates")!,
      ) as { index: number };
      expect(stored.index).toBe(0);
    });
  });

  describe("#connect failure", () => {
    // Resolving here reports a connect that built nothing as success:
    // spawnConnection's cleanup never runs, so its registry entry is gone while
    // the caller is told all is well; an automatic restart never reports the
    // failure, so the lease is held for a phone with no socket; and POST
    // /restart answers 202 for a replacement that does not exist.
    it("propagates a socket that could not be created", async () => {
      const baileysMod = (await import("@whiskeysockets/baileys")) as any;
      const makeSocket = baileysMod.default as ReturnType<typeof mock>;
      makeSocket.mockImplementationOnce(() => {
        throw new Error("socket construction failed");
      });

      await expect(connection.connect()).rejects.toThrow(
        "socket construction failed",
      );
    });
  });

  describe("#connect failure", () => {
    // Reconnects are fire-and-forget, and connect() now rejects when it cannot
    // build a socket at all. An unhandled rejection is fatal in Bun, so one
    // failed reconnect would take the worker down and every other connection
    // with it. Aborting rather than only logging, because a connection left
    // registered with no socket is the dark phone this change exists to end.
    it("aborts instead of crashing when a reconnect cannot rebuild", async () => {
      const closes: string[] = [];
      connection = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        onConnectionClose: () => closes.push("closed"),
      });
      await connection.connect();

      const baileysMod = (await import("@whiskeysockets/baileys")) as any;
      const makeSocket = baileysMod.default as ReturnType<typeof mock>;
      makeSocket.mockImplementationOnce(() => {
        throw new Error("no socket for you");
      });

      await mockEventHandlers.get("connection.update")?.({
        connection: "close" as const,
        lastDisconnect: {
          error: { output: { statusCode: 500, payload: {} }, message: "x" },
        },
      });

      for (let i = 0; i < 50 && closes.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      expect(closes.length).toBeGreaterThan(0);
      expect(connection.isOpen).toBe(false);
    });
  });

  describe("#sendMessage", () => {
    it("throws BaileysNotConnectedError if not connected", async () => {
      await expect(
        connection.sendMessage("jid@s.whatsapp.net", { text: "hi" }),
      ).rejects.toThrow(BaileysNotConnectedError);
    });

    it("calls socket sendMessage", async () => {
      await connection.connect();
      await connection.sendMessage("jid@s.whatsapp.net", { text: "hi" });
      expect(mockSocket.sendMessage).toHaveBeenCalled();
    });

    it("forwards a caller-provided messageId to the socket", async () => {
      await connection.connect();
      mockSocket.sendMessage.mockClear();
      await connection.sendMessage(
        "jid@s.whatsapp.net",
        { text: "hi" },
        { messageId: "3EB0RESERVED" },
      );
      expect(mockSocket.sendMessage).toHaveBeenCalledWith(
        "jid@s.whatsapp.net",
        { text: "hi" },
        expect.objectContaining({ messageId: "3EB0RESERVED" }),
      );
    });

    // Baileys spreads our options over its own `messageId` default, so passing
    // the key as undefined would silently downgrade that default.
    it("omits messageId entirely when the caller did not reserve one", async () => {
      await connection.connect();
      mockSocket.sendMessage.mockClear();
      await connection.sendMessage("jid@s.whatsapp.net", { text: "hi" });
      const options = mockSocket.sendMessage.mock.calls[0]?.[2];
      expect(Object.keys(options as object)).not.toContain("messageId");
    });
  });

  describe("#isOpen", () => {
    // Reported by the health endpoint, where "we hold the object" would be a
    // false connectivity signal during QR pairing and reconnect backoff.
    it("follows the socket's state rather than the connection's existence", async () => {
      expect(connection.isOpen).toBe(false);
      await connection.connect();
      expect(connection.isOpen).toBe(false);

      await mockEventHandlers.get("connection.update")?.({
        connection: "open",
      });
      expect(connection.isOpen).toBe(true);

      await mockEventHandlers.get("connection.update")?.({
        connection: "connecting",
      });
      expect(connection.isOpen).toBe(false);
    });

    // The reconnect branch returns before the assignment at the bottom of
    // handleConnectionUpdate, and on its way out it creates the replacement
    // socket — so a state recorded only there would leave `open` standing while
    // `socket !== null` came back, and the health endpoint would report
    // `connected: true` for the whole handshake.
    it("stops reporting open the moment an established socket closes", async () => {
      await connection.connect();
      await mockEventHandlers.get("connection.update")?.({
        connection: "open",
      });
      expect(connection.isOpen).toBe(true);

      await mockEventHandlers.get("connection.update")?.({
        connection: "close" as const,
        lastDisconnect: {
          error: {
            output: {
              statusCode: 500,
              payload: {
                statusCode: 500,
                error: "Unknown",
                message: "Stream Errored",
              },
            },
            message: "Stream Errored",
          },
        },
      });

      // The reconnect leaves `socket` null only until connect() finishes, and
      // isOpen would answer false for that reason alone. Stand a socket back up
      // directly instead of racing the async reconnect, so what is asserted is
      // the recorded state and not the gap.
      (connection as unknown as { socket: unknown }).socket = {};

      expect(connection.isOpen).toBe(false);
    });
  });

  // A later POST /connections reuses a live connection and mutates its options
  // in place. Anything that rebuilds the socket has to read the current values,
  // or connect() would persist the superseded ones back to Redis and revert a
  // webhook reconfiguration.
  describe("#currentOptions", () => {
    it("reflects options updated after the connection was built", async () => {
      await connection.connect();
      await connection.updateOptions({
        webhookUrl: "http://example.com/new",
        webhookVerifyToken: "new-token",
        leaseEpoch: 7,
      });

      expect(connection.currentOptions).toMatchObject({
        webhookUrl: "http://example.com/new",
        webhookVerifyToken: "new-token",
        leaseEpoch: 7,
      });
    });
  });

  describe("send stall watchdog", () => {
    const wedge = () =>
      mockSocket.sendMessage.mockImplementation(
        () => new Promise<never>(() => {}),
      );
    const send = () =>
      connection.sendMessage("jid@s.whatsapp.net", { text: "hi" });
    // A stall is a claim about a socket that is UP: during a first connect or a
    // slow reconnect the socket object exists while the handshake is still
    // running, and sends timing out in that window are an ordinary outage. The
    // watchdog now requires the open, so these examples have to reach it.
    const connectOpen = async () => {
      await connection.connect();
      await mockEventHandlers.get("connection.update")?.({
        connection: "open",
      });
    };

    // The strike write is a compare-and-set EVAL now, not a plain SET. This runs
    // `during` at the moment that write lands and then applies what the script
    // would have written, so an example can still drive the race it is about.
    const interceptStrikeWrite = (during: () => void | Promise<void>) => {
      const evalMock = redis.eval as unknown as ReturnType<typeof mock>;
      const keysWritten: string[] = [];
      evalMock.mockImplementationOnce(
        async (
          _script: string,
          opts: { keys: string[]; arguments: string[] },
        ) => {
          keysWritten.push(opts.keys[0]);
          await during();
          (
            redis as unknown as { __stringData: Map<string, string> }
          ).__stringData.set(opts.keys[0], opts.arguments[1]);
          return 1;
        },
      );
      return keysWritten;
    };

    beforeEach(() => {
      config.baileys.sendTimeoutMs = 10;
      config.baileys.sendStallRestartEnabled = false;
    });

    afterEach(() => {
      config.baileys.sendTimeoutMs = 45_000;
      config.baileys.audioPreprocessTimeoutMs = 20_000;
      config.baileys.sendStallRestartEnabled = false;
      mockSocket.sendMessage.mockImplementation(async () => ({
        key: { id: "msg-id" },
      }));
      // The restart cooldown is process-wide state on the class, so it leaks
      // between examples: without this reset, whichever example claims the slot
      // first silently starves every later one for 30 real seconds.
      (
        BaileysConnection as unknown as { lastStallRestartAt: number }
      ).lastStallRestartAt = Number.NEGATIVE_INFINITY;
    });

    it("fails a send that never completes instead of hanging forever", async () => {
      await connectOpen();
      wedge();
      await expect(send()).rejects.toThrow(OperationTimeoutError);
    });

    // The circuit breaker. Without it every caller retry parks another
    // operation behind the wedged keystore mutex, and if that mutex ever
    // releases while the socket is still open they all fire at once — a burst
    // of duplicate messages to real customers, hours late.
    it("stops touching the socket once the connection is known stalled", async () => {
      await connectOpen();
      wedge();
      mockSocket.sendMessage.mockClear();

      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(BaileysSendStalledError);
      await expect(send()).rejects.toThrow(BaileysSendStalledError);

      expect(mockSocket.sendMessage.mock.calls.length).toBe(3);
    });

    // Once the wedge starts reporting itself through mutex timeouts, every
    // abandoned send rejects with E_TX_MUTEX_TIMEOUT, which recordLateSettle
    // refuses to read as recovery. An open breaker means no send reaches the
    // socket, so the ordinary success path that would close it can never run --
    // and with restart disabled (the default) the connection would answer 503 for
    // the life of a socket whose mutex freed itself hours ago.
    it("closes the breaker when the wedged keystore key is released", async () => {
      await connectOpen();
      const baileysModule = (await import("@whiskeysockets/baileys")) as any;
      const makeSocket = baileysModule.default as ReturnType<typeof mock>;
      const emit = (event: Record<string, unknown>) =>
        makeSocket.mock.calls
          .at(-1)![0]
          .transactionOpts.onTransactionEvent(event);

      // The send's own failure is what names the blocked key, exactly as in
      // production: the Boom the patched transaction throws carries it.
      mockSocket.sendMessage.mockImplementation(() =>
        Promise.reject(
          Object.assign(new Error("keystore transaction timed out"), {
            data: { key: "me@s.whatsapp.net", code: "E_TX_MUTEX_TIMEOUT" },
          }),
        ),
      );
      await expect(send()).rejects.toThrow("keystore transaction timed out");
      await expect(send()).rejects.toThrow("keystore transaction timed out");
      await expect(send()).rejects.toThrow("keystore transaction timed out");
      await expect(send()).rejects.toThrow(BaileysSendStalledError);

      // An unrelated key holding past the warn threshold, then releasing. Both
      // must be inert: `stalled` names whatever key is held long, not the one
      // blocking sends, and a release on a key we were never waiting for proves
      // nothing -- the mutexes live in a per-key map.
      emit({
        phase: "stalled",
        key: "lid-mapping",
        waitedMs: 0,
        heldMs: 31_000,
      });
      emit({
        phase: "released",
        key: "lid-mapping",
        waitedMs: 0,
        heldMs: 32_000,
      });
      await expect(send()).rejects.toThrow(BaileysSendStalledError);

      emit({
        phase: "released",
        key: "me@s.whatsapp.net",
        waitedMs: 0,
        heldMs: 120_000,
      });

      mockSocket.sendMessage.mockClear();
      await expect(send()).rejects.toThrow("keystore transaction timed out");
      expect(mockSocket.sendMessage).toHaveBeenCalled();
    });

    // recordSendTimeout drops a stale generation, but noteMutexWedge ran first and
    // stamped the replaced socket's key onto the live watchdog. A release on THAT
    // key then closes a breaker that is open because of a different one.
    it("ignores a mutex timeout that belongs to a replaced socket", async () => {
      config.baileys.sendTimeoutMs = 5_000;
      await connectOpen();
      const baileysModule = (await import("@whiskeysockets/baileys")) as any;
      const makeSocket = baileysModule.default as ReturnType<typeof mock>;
      const emit = (event: Record<string, unknown>) =>
        makeSocket.mock.calls
          .at(-1)![0]
          .transactionOpts.onTransactionEvent(event);

      // A send left in flight on the socket that is about to be replaced.
      let rejectStale!: (error: unknown) => void;
      mockSocket.sendMessage.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectStale = reject;
          }),
      );
      const stale = send().catch(() => "settled");

      await mockEventHandlers.get("connection.update")!({
        connection: "close" as const,
        lastDisconnect: {
          error: { output: { statusCode: 500, payload: {} }, message: "x" },
        },
      });
      let stable = -1;
      while (stable !== makeSocket.mock.calls.length) {
        stable = makeSocket.mock.calls.length;
        await new Promise((r) => setImmediate(r));
      }
      await mockEventHandlers.get("connection.update")?.({
        connection: "open",
      });

      // The replacement wedges on its OWN key, which is what the breaker is about.
      mockSocket.sendMessage.mockImplementation(() =>
        Promise.reject(
          Object.assign(new Error("live wedge"), {
            data: { key: "live-key", code: "E_TX_MUTEX_TIMEOUT" },
          }),
        ),
      );
      await expect(send()).rejects.toThrow("live wedge");
      await expect(send()).rejects.toThrow("live wedge");
      await expect(send()).rejects.toThrow("live wedge");
      await expect(send()).rejects.toThrow(BaileysSendStalledError);

      // Only now does the replaced socket's send report its own, different key.
      rejectStale(
        Object.assign(new Error("stale wedge"), {
          data: { key: "stale-key", code: "E_TX_MUTEX_TIMEOUT" },
        }),
      );
      await stale;

      // A key the live socket was never blocked on says nothing about it.
      emit({ phase: "released", key: "stale-key", waitedMs: 0, heldMs: 1_000 });
      await expect(send()).rejects.toThrow(BaileysSendStalledError);
    });

    // `isOnline` is a presence echo on the socket we already have, not a
    // handshake result: sendPresenceUpdate("available") emits one, and POST
    // /connections calls exactly that when it reuses a live connection -- which
    // is the Chatwoot health check, every five minutes. Taken as connectivity it
    // flips isOpen mid-handshake, which is the gate deciding whether a run of
    // timeouts is an ordinary reconnect outage or a send stall.
    it("does not treat a presence echo as the socket being open", async () => {
      // Deliberately no `open`: the handshake has not finished.
      await connection.connect();
      expect(connection.isOpen).toBe(false);

      await mockEventHandlers.get("connection.update")?.({ isOnline: true });

      expect(connection.isOpen).toBe(false);
      // The rewrite itself stays: clients are still told `open`, which is the
      // contract this echo has always had.
      expect(
        fetchCalls.some(
          (call) =>
            call.body.includes('"isOnline":true') &&
            call.body.includes('"connection":"open"'),
        ),
      ).toBe(true);

      wedge();
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);

      // An ordinary outage, not a stall: the socket never opened.
      await expect(send()).rejects.toThrow(BaileysNotConnectedError);
      expect(connection.sendState).not.toBe("stalled");
    });

    // The queue cap is exactly what a send lands on during an ordinary outage: a
    // socket that closes with its sends unresolved keeps every one of them
    // holding a slot, because the slot belongs to the operation and not to our
    // wait on it. Answering `stalled` there tells the caller the connection is up
    // and must NOT be marked down, and costs it the reconnect it needed.
    it("reports a closed socket as disconnected even with the send queue full", async () => {
      await connectOpen();
      wedge();

      // Eight concurrent sends, started before any of them can time out, so all
      // eight take a slot instead of being turned away by the breaker.
      const inFlight = Array.from({ length: 8 }, () => send().catch(() => {}));
      await new Promise((r) => setTimeout(r, 5));

      // The queue is full: a ninth send is refused without reaching the socket.
      const callsBefore = mockSocket.sendMessage.mock.calls.length;
      await expect(send()).rejects.toThrow(BaileysSendStalledError);
      expect(mockSocket.sendMessage.mock.calls.length).toBe(callsBefore);

      // Now the socket drops. The eight are still parked, so the cap still bites
      // -- but this is an outage, not a wedge.
      (connection as unknown as { connectionState: string }).connectionState =
        "close";

      await expect(send()).rejects.toThrow(BaileysNotConnectedError);
      expect(connection.sendState).not.toBe("stalled");

      await Promise.all(inFlight);
    });

    // The one late verdict that is not ambiguous. A mutex-acquire timeout means
    // the waiter never entered txStorage.run -- it read nothing, wrote nothing
    // and relayed nothing -- so the "outcome unknown" its caller was already
    // given is now known, and the marker holding that caller's resend can go.
    it("tells the caller when a parked send is proved never to have been sent", async () => {
      await connectOpen();
      let notSent = 0;
      let rejectLate: ((error: unknown) => void) | undefined;
      mockSocket.sendMessage.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectLate = reject;
          }),
      );
      const sendWithHook = () =>
        connection.sendMessage(
          "jid@s.whatsapp.net",
          { text: "hi" },
          {
            onLateDefinitiveFailure: () => {
              notSent += 1;
            },
          },
        );

      await expect(sendWithHook()).rejects.toThrow(OperationTimeoutError);
      // Still unknown at this point: the send is parked, not resolved.
      expect(notSent).toBe(0);

      rejectLate?.(
        Object.assign(new Error("keystore transaction timed out"), {
          data: { key: "me@s.whatsapp.net", code: "E_TX_MUTEX_TIMEOUT" },
        }),
      );
      await new Promise((r) => setTimeout(r, 5));
      expect(notSent).toBe(1);

      // Any other late failure stays ambiguous -- media generation and upload run
      // BEFORE the transaction is taken, so a rejection from there says nothing
      // about whether a message went out.
      await expect(sendWithHook()).rejects.toThrow(OperationTimeoutError);
      rejectLate?.(new Error("upload failed"));
      await new Promise((r) => setTimeout(r, 5));
      expect(notSent).toBe(1);
    });

    // The holder can let go between the acquisition giving up and the Boom
    // reaching the breaker. handleTxEvent sees that release while nothing is
    // armed yet and rightly ignores it -- and it is the only one that key will
    // ever emit, so arming afterwards waits for a second release that never
    // comes. With automatic restart off, that is 503 for the life of a socket
    // whose mutex is free: the round 16 latch, through a narrower door.
    it("does not arm on a key that released while its timeout propagated", async () => {
      await connectOpen();
      const baileysModule = (await import("@whiskeysockets/baileys")) as any;
      const makeSocket = baileysModule.default as ReturnType<typeof mock>;
      const emit = (event: Record<string, unknown>) =>
        makeSocket.mock.calls
          .at(-1)![0]
          .transactionOpts.onTransactionEvent(event);
      const wedgeError = () =>
        Promise.reject(
          Object.assign(new Error("keystore transaction timed out"), {
            data: { key: "me@s.whatsapp.net", code: "E_TX_MUTEX_TIMEOUT" },
          }),
        );

      // Once, and only once: the patch emits `timeout` and throws in the same
      // breath, and the holder's release lands while that Boom is still
      // travelling up the send path. That release is the only one this key will
      // ever emit -- the holder is gone.
      mockSocket.sendMessage.mockImplementationOnce(() => {
        emit({ phase: "timeout", key: "me@s.whatsapp.net", waitedMs: 90_000 });
        emit({
          phase: "released",
          key: "me@s.whatsapp.net",
          waitedMs: 0,
          heldMs: 90_001,
        });
        return wedgeError();
      });
      mockSocket.sendMessage.mockImplementation(wedgeError);

      await expect(send()).rejects.toThrow("keystore transaction timed out");
      await expect(send()).rejects.toThrow("keystore transaction timed out");
      await expect(send()).rejects.toThrow("keystore transaction timed out");

      // That first failure did not count towards a wedge, because the wedge had
      // already cleared. Two strikes, not three, so the socket is still reachable.
      mockSocket.sendMessage.mockClear();
      await expect(send()).rejects.toThrow("keystore transaction timed out");
      expect(mockSocket.sendMessage).toHaveBeenCalled();
    });

    // The audio work can await for the whole preprocessing budget, and a
    // reconnect inside that window clears the id history with the socket that
    // owned it. The send then leaves on the replacement carrying a reserved id
    // the history no longer holds, so every ack for it is rejected as not ours
    // and lastOutgoingAckAt -- the only evidence that does not come from us --
    // stays null for a send that went through perfectly.
    it("re-registers a reserved id when the socket changed during preprocessing", async () => {
      await connectOpen();
      const baileysModule = (await import("@whiskeysockets/baileys")) as any;
      const makeSocket = baileysModule.default as ReturnType<typeof mock>;

      const preprocess = preprocessAudio as unknown as ReturnType<typeof mock>;
      const reconnectDuringPreprocessing = async () => {
        await mockEventHandlers.get("connection.update")!({
          connection: "close" as const,
          lastDisconnect: {
            error: { output: { statusCode: 500, payload: {} }, message: "x" },
          },
        });
        let stable = -1;
        while (stable !== makeSocket.mock.calls.length) {
          stable = makeSocket.mock.calls.length;
          await new Promise((r) => setImmediate(r));
        }
        await mockEventHandlers.get("connection.update")?.({
          connection: "open",
        });
        return Buffer.from("converted");
      };
      preprocess.mockImplementationOnce(reconnectDuringPreprocessing);
      preprocess.mockImplementationOnce(async () => Buffer.from("wav"));

      await connection.sendMessage(
        "jid@s.whatsapp.net",
        { audio: Buffer.from("audio"), ptt: true } as never,
        { messageId: "3EB0RESERVED" },
      );

      mockEventHandlers.get("messages.update")?.([
        { key: { fromMe: true, id: "3EB0RESERVED" }, update: { status: 2 } },
      ]);

      expect(connection.lastOutgoingAckAt).not.toBeNull();
    });

    // The mirror of the reconnect finding: maybeReportSendStall already refuses to
    // call this a stall while the socket is not open, and the REFUSAL has to agree.
    // The stall-specific 503 tells the caller the connection is up and must not be
    // marked down, which would cost a handshaking socket the reconnect it needed.
    it("refuses as not-connected, not as stalled, while the socket is not open", async () => {
      // Deliberately no `open`: the socket object exists, the handshake does not.
      await connection.connect();
      wedge();
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);

      await expect(send()).rejects.toThrow(BaileysNotConnectedError);
      expect(connection.sendState).not.toBe("stalled");
    });

    // The breaker counts refusals by ONE socket's keystore mutex, and a replacement
    // brings a new one. A streak that survives the swap accuses the wrong socket:
    // two stale timeouts plus one during the new handshake (safeSocket only needs a
    // socket object, and the replacement has one before `open` arrives) answer the
    // stall-specific 503 for what was an ordinary reconnect.
    it("does not carry a send-timeout streak across a new socket", async () => {
      await connectOpen();
      wedge();
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);

      // A real reconnect through the close path, not a hand-cleared counter:
      // creating the socket is what bumps the generation, so it is what has to
      // take the streak along.
      const baileysModule = (await import("@whiskeysockets/baileys")) as any;
      const makeSocket = baileysModule.default as ReturnType<typeof mock>;
      const socketsBefore = makeSocket.mock.calls.length;
      await mockEventHandlers.get("connection.update")!({
        connection: "close" as const,
        lastDisconnect: {
          error: { output: { statusCode: 500, payload: {} }, message: "x" },
        },
      });
      let stable = -1;
      while (stable !== makeSocket.mock.calls.length) {
        stable = makeSocket.mock.calls.length;
        await new Promise((r) => setImmediate(r));
      }
      expect(makeSocket.mock.calls.length).toBeGreaterThan(socketsBefore);
      // The replacement comes with its own mock, at zero calls; wedge that one.
      wedge();

      // Three, all admitted: this socket has refused none of them yet.
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      expect(mockSocket.sendMessage.mock.calls.length).toBe(3);
    });

    // Which deadline fires first is decided by configuration, not by the failure:
    // BAILEYS_TX_ACQUIRE_TIMEOUT_MS set below BAILEYS_SEND_TIMEOUT_MS makes the wedge
    // report itself before our own deadline does. Counting only OperationTimeoutError
    // would blind the detector in exactly the setup that detects a wedge fastest.
    it("counts a keystore mutex timeout toward the breaker", async () => {
      await connectOpen();
      mockSocket.sendMessage.mockImplementation(() =>
        Promise.reject(
          Object.assign(new Error("keystore transaction timed out"), {
            data: { key: "me@s.whatsapp.net", code: "E_TX_MUTEX_TIMEOUT" },
          }),
        ),
      );
      mockSocket.sendMessage.mockClear();

      await expect(send()).rejects.toThrow("keystore transaction timed out");
      await expect(send()).rejects.toThrow("keystore transaction timed out");
      await expect(send()).rejects.toThrow("keystore transaction timed out");
      await expect(send()).rejects.toThrow(BaileysSendStalledError);

      expect(mockSocket.sendMessage.mock.calls.length).toBe(3);
    });

    // The audio work is deliberately OUTSIDE the send deadline: ffmpeg is local
    // and legitimately slow, so charging it to the send budget would open the
    // breaker and recreate a socket that refused nothing. But it runs BEFORE that
    // deadline is armed, so leaving it unbounded defeats the guarantee
    // sendTimeoutMs < PROXY_REQUEST_TIMEOUT_MS exists to give: the proxy cuts
    // first, answers its own generic 504, and the worker never reaches the code
    // that releases the idempotency lock or counts the stall.
    it("bounds the audio preprocessing that precedes the send deadline", async () => {
      await connectOpen();
      config.baileys.audioPreprocessTimeoutMs = 10;
      // Honours the signal, like the real implementation: what this layer owes is
      // a deadline the worker can act on, and a stub that ignores it would pass
      // whether or not one was ever passed. mockImplementationOnce, twice (a PTT
      // runs two jobs), so nothing leaks into the spec that exercises the real
      // preprocessAudio.
      const parked = (
        _audio: unknown,
        _format: unknown,
        signal?: AbortSignal,
      ) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      const preprocess = preprocessAudio as unknown as ReturnType<typeof mock>;
      preprocess.mockImplementationOnce(parked);
      preprocess.mockImplementationOnce(parked);

      // Raced rather than awaited: without the deadline this send never settles,
      // and a hung example is a worse CI failure than a failed assertion.
      const outcome = await Promise.race([
        connection
          .sendMessage("jid@s.whatsapp.net", {
            audio: Buffer.from("audio"),
            ptt: true,
          } as never)
          .then(() => "sent"),
        new Promise((resolve) => setTimeout(() => resolve("hung"), 500)),
      ]);

      expect(outcome).toBe("sent");
      expect(mockSocket.sendMessage).toHaveBeenCalled();
    });

    // The breaker only opens after three COMPLETED timeouts, a whole send
    // deadline away. Everything arriving inside that first window passes an empty
    // counter and parks behind the wedged mutex, and those operations are not
    // cancellable: if the mutex frees while the socket is alive they all fire at
    // once, hours late, at a real customer whose caller long since retried. The
    // queue depth was "however many sends arrived in 45 seconds", not three.
    it("caps how many sends can queue behind a wedged mutex", async () => {
      await connectOpen();
      wedge();
      mockSocket.sendMessage.mockClear();

      // None of these settle, so none of them are counted yet -- which is the
      // whole point: the breaker cannot see them.
      const pending = Array.from({ length: 12 }, () =>
        send().catch(() => "rejected"),
      );
      await Promise.all(pending);

      expect(mockSocket.sendMessage.mock.calls.length).toBeLessThanOrEqual(8);
    });

    // The slot belongs to the operation, not to our wait on it. Giving it back
    // when withTimeout rejects lets a replacement in while the abandoned send is
    // still parked in the mutex -- so the queue grows past the ceiling exactly
    // when the breaker closes, which is the moment sends start flowing again.
    it("keeps a timed-out send's slot until the operation settles", async () => {
      await connectOpen();
      wedge();
      mockSocket.sendMessage.mockClear();

      // Eight admitted, all timing out, none of them settling underneath.
      await Promise.all(
        Array.from({ length: 8 }, () => send().catch(() => "rejected")),
      );
      expect(mockSocket.sendMessage.mock.calls.length).toBe(8);

      // An `open` clears the breaker -- but the eight operations are still
      // parked, so the ceiling has to keep holding on its own.
      await mockEventHandlers.get("connection.update")?.({
        connection: "open",
      });
      mockSocket.sendMessage.mockClear();

      await expect(send()).rejects.toThrow(BaileysSendStalledError);
      expect(mockSocket.sendMessage).not.toHaveBeenCalled();
    });

    // preprocessAudio runs up to two ffmpeg jobs for a PTT. A caller retrying into
    // a stalled connection would burn that CPU on every attempt only to be told 503
    // at the end, which is not what "fails immediately" means.
    it("refuses a stalled send before spending ffmpeg on it", async () => {
      await connectOpen();
      wedge();
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);

      // The preload already replaces this module, so read ITS mock rather than
      // laying a spy over it: a spy on an already-mocked module export outlives
      // mockRestore and breaks the spec that tests the real implementation.
      const preprocess = preprocessAudio as unknown as ReturnType<typeof mock>;
      preprocess.mockClear();

      await expect(
        connection.sendMessage("jid@s.whatsapp.net", {
          audio: Buffer.from("fake-audio"),
          ptt: true,
        }),
      ).rejects.toThrow(BaileysSendStalledError);

      expect(preprocess.mock.calls.length).toBe(0);
    });

    // The failure is total: one success proves the mutex is free, so the
    // counter has to reset rather than accumulate across unrelated hiccups.
    it("resets the streak after a send succeeds", async () => {
      await connectOpen();
      wedge();
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      expect(connection.consecutiveSendTimeouts).toBe(2);

      mockSocket.sendMessage.mockImplementation(async () => ({
        key: { id: "msg-id" },
      }));
      await send();

      expect(connection.consecutiveSendTimeouts).toBe(0);
      expect(connection.sendState).toBe("ok");
    });

    // Three concurrent sends started together all expire at sendTimeoutMs, so
    // a bare "three in a row" rule would let one short hiccup recreate a
    // perfectly healthy socket.
    it("does not report a stall until the streak has lasted long enough", async () => {
      await connectOpen();
      wedge();
      fetchCalls.length = 0;

      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);

      expect(
        fetchCalls.some((call) => call.body.includes("send_stall_detected")),
      ).toBe(false);
    });

    // Depth alone latches the breaker, and once it is open no send reaches the
    // socket, so no further timeout is ever recorded. If the trigger were only
    // evaluated on a fresh timeout, three concurrent sends would disarm the
    // watchdog for the life of the socket: 503 forever, no webhook, no restart.
    it("still reports the stall once the latched streak ages past the minimum", async () => {
      await connectOpen();
      wedge();
      const start = Date.now();

      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      fetchCalls.length = 0;

      setSystemTime(new Date(start + 120_000));
      await expect(send()).rejects.toThrow(BaileysSendStalledError);
      await asyncSleep(0);

      expect(
        fetchCalls.some((call) => call.body.includes("send_stall_detected")),
      ).toBe(true);
      setSystemTime();
    });

    // The breaker rejects for as long as the socket lives, so an unguarded
    // re-evaluation would emit one webhook per rejected send.
    it("reports the stall once per episode, not once per rejected send", async () => {
      await connectOpen();
      wedge();
      const start = Date.now();

      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      setSystemTime(new Date(start + 120_000));
      fetchCalls.length = 0;

      await expect(send()).rejects.toThrow(BaileysSendStalledError);
      await expect(send()).rejects.toThrow(BaileysSendStalledError);
      await expect(send()).rejects.toThrow(BaileysSendStalledError);
      await asyncSleep(0);

      expect(
        fetchCalls.filter((call) => call.body.includes("send_stall_detected"))
          .length,
      ).toBe(1);
      setSystemTime();
    });

    it("emits send_stall_detected once the streak is long enough", async () => {
      await connectOpen();
      wedge();
      const start = Date.now();

      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      // Push the streak past the minimum duration before the third timeout.
      setSystemTime(new Date(start + 120_000));
      fetchCalls.length = 0;
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await asyncSleep(0);

      const stall = fetchCalls.find((call) =>
        call.body.includes("send_stall_detected"),
      );
      expect(stall).toBeDefined();
      const payload = JSON.parse(stall?.body ?? "{}");
      expect(payload.data.sendStall.action).toBe("suppressed");
      expect(payload.data.sendStall.consecutiveTimeouts).toBe(3);
      setSystemTime();
    });

    // The process-wide cooldown spreads a fleet-wide stall over minutes. It is
    // a scheduling delay, not a verdict, so the episode must stay open: closing
    // it here would turn 8 stalled inboxes into 8 alerts and 1 recovery.
    it("keeps the episode open when the restart is only deferred by the cooldown", async () => {
      const restarts: string[] = [];
      connection = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        requestRestart: (reason: string) => restarts.push(reason),
      });
      config.baileys.sendStallRestartEnabled = true;
      // Another connection in this process restarted a moment ago.
      (
        BaileysConnection as unknown as { lastStallRestartAt: number }
      ).lastStallRestartAt = performance.now();
      await connectOpen();
      wedge();
      const start = Date.now();

      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      setSystemTime(new Date(start + 120_000));
      fetchCalls.length = 0;
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await asyncSleep(0);

      // Deferred, not decided: no restart, and no "suppressed" webhook that
      // would read as a verdict on this connection.
      expect(restarts.length).toBe(0);
      expect(
        fetchCalls.some((call) => call.body.includes("send_stall_detected")),
      ).toBe(false);

      // The episode is still open, so the next attempt re-evaluates instead of
      // silently giving up for the life of the socket.
      await expect(send()).rejects.toThrow(BaileysSendStalledError);
      await asyncSleep(0);
      expect(restarts.length).toBe(0);

      setSystemTime();
    });

    it("recreates the socket through the handler when restart is enabled", async () => {
      const restarts: string[] = [];
      connection = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        requestRestart: (reason: string) => {
          restarts.push(reason);
          // What the real handler does. connectionsHandler.connect runs
          // synchronously up to its first await when the per-number slot is
          // free, and discard() is inside that stretch -- so anything this
          // connection does AFTER calling requestRestart sees itself discarded.
          // A double that skips this hid exactly that, and the strike below
          // stopped being recorded at all.
          (connection as unknown as { isDiscarded: boolean }).isDiscarded =
            true;
        },
      });
      config.baileys.sendStallRestartEnabled = true;
      await connectOpen();
      wedge();
      const start = Date.now();

      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      setSystemTime(new Date(start + 120_000));
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await asyncSleep(0);

      expect(restarts.length).toBe(1);
      expect(restarts[0]).toContain("send stall");
      // The strike lands only once the restart has actually been asked for. The
      // ordering is what guarantees "a strike implies a restart"; this pins the
      // committed half of it, since with the recording moved after the final gate
      // there is no longer an await in that span for a cancellation to slip into.
      expect(
        JSON.parse(
          (await redis.get(clusterKeys.sendStall("+5511999999999"))) ?? "{}",
        ).restarts,
      ).toBe(1);
      setSystemTime();
      await redis.del(clusterKeys.sendStall("+5511999999999"));
    });

    // The distributed fence, and this was the one socket-creating path without
    // it: the claim cycle acquires, the explicit paths force-acquire behind a
    // live-owner guard, and the connectionReplaced kick yields on the same
    // lease read. The watchdog decided on local state alone, so a phone
    // force-taken over while this handler awaited Redis would be rebuilt here
    // under a lease that is no longer ours -- two sockets fighting for one
    // identity until the next renew cycle noticed.
    it("yields instead of restarting when the lease moved to another instance", async () => {
      const restarts: string[] = [];
      let closed = 0;
      connection = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        requestRestart: (reason: string) => restarts.push(reason),
        onConnectionClose: () => {
          closed += 1;
        },
      });
      config.baileys.sendStallRestartEnabled = true;
      await connectOpen();
      wedge();
      const start = Date.now();

      // Another instance force-acquired this phone -- our registry entry went
      // stale for a beat and it took us for dead.
      (redis as any).__stringData.set(
        "@baileys-api:cluster:lease:+5511999999999",
        JSON.stringify({ owner: "other-instance", epoch: 9 }),
      );
      fetchCalls.length = 0;

      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      setSystemTime(new Date(start + 120_000));
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await new Promise((r) => setTimeout(r, 5));

      // No socket rebuilt under a lease that is not ours.
      expect(restarts.length).toBe(0);
      // And no strike spent. The backoff key is per phone number and
      // cluster-wide, so charging one here would suppress the watchdog of the
      // instance that legitimately owns the number.
      expect(
        await redis.get(clusterKeys.sendStall("+5511999999999")),
      ).toBeNull();
      // Nothing narrated either: the new owner speaks for this number now, and
      // our webhook would carry the older epoch.
      expect(
        fetchCalls.some((call) => call.body.includes("send_stall_detected")),
      ).toBe(false);
      // Aborted, not merely skipped -- a socket for a phone somebody else owns
      // is a duplicate that is still receiving.
      expect(closed).toBe(1);
      expect(connection.isOpen).toBe(false);

      setSystemTime();
    });

    // The fence above is one Redis round trip old by the time the restart is
    // actually asked for, and a takeover can land inside that round trip. This is
    // the one that has to hold, because it is the last point before the socket is
    // rebuilt.
    it("yields when the lease moves while the strike is being written", async () => {
      const key = clusterKeys.sendStall("+5511999999999");
      const stringData = (
        redis as unknown as { __stringData: Map<string, string> }
      ).__stringData;
      // An earlier genuine episode, already past its backoff window, so the
      // rollback has something to restore and can be told apart from a wipe.
      stringData.set(
        key,
        JSON.stringify({ restarts: 1, nextRestartAllowedAt: Date.now() - 1 }),
      );

      const restarts: string[] = [];
      let closed = 0;
      connection = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        requestRestart: (reason: string) => restarts.push(reason),
        onConnectionClose: () => {
          closed += 1;
        },
      });
      config.baileys.sendStallRestartEnabled = true;
      await connectOpen();
      wedge();

      const realRecord = sendStallStore.recordRestart;
      const record = spyOn(sendStallStore, "recordRestart").mockImplementation(
        async (phone: string) => {
          // Another instance force-acquires inside the window this write
          // occupies -- after the earlier fence read, before the later one.
          stringData.set(
            "@baileys-api:cluster:lease:+5511999999999",
            JSON.stringify({ owner: "other-instance", epoch: 9 }),
          );
          return realRecord(phone);
        },
      );

      try {
        const start = Date.now();
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        setSystemTime(new Date(start + 120_000));
        fetchCalls.length = 0;
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await new Promise((r) => setTimeout(r, 5));

        // The write did happen -- the fence is downstream of it.
        expect(record).toHaveBeenCalledTimes(1);
        // No socket rebuilt against the legitimate owner's.
        expect(restarts.length).toBe(0);
        // And the increment is taken back rather than the key wiped: the backoff
        // is cluster-wide, so charging a strike for a restart we are not
        // performing would suppress the new owner's watchdog, while deleting
        // would hand the phone a clean slate an earlier episode already spent.
        expect(JSON.parse(stringData.get(key) ?? "{}").restarts).toBe(1);
        expect(closed).toBe(1);
        expect(connection.isOpen).toBe(false);
        expect(
          fetchCalls.some((call) => call.body.includes("send_stall_detected")),
        ).toBe(false);
      } finally {
        record.mockRestore();
        setSystemTime();
        await redis.del(key);
      }
    });

    // `failed` and `cancelled` exist to retract a `restart` already announced, and
    // sendToWebhook gives no ordering: each payload runs its own retry loop, so a
    // `restart` that needed a second attempt lands after a `failed` that went out
    // on the first. A consumer reading them in that order concludes recovery is
    // underway on a connection that never came back, which is the exact reading
    // this feature exists to prevent.
    it("delivers the restart verdict before the failure that retracts it", async () => {
      const delivered: string[] = [];
      const outerFetch = globalThis.fetch;
      const outerRetries = config.webhook.retryPolicy.maxRetries;
      // One retry, so the restart verdict's first attempt can fail while the
      // failure verdict's first attempt succeeds.
      config.webhook.retryPolicy.maxRetries = 1;
      let restartAttempts = 0;
      globalThis.fetch = mock(
        async (_url: string | URL | Request, init?: RequestInit) => {
          const body = (init?.body as string) ?? "";
          if (body.includes('"action":"restart"')) {
            restartAttempts += 1;
            if (restartAttempts === 1) {
              return new Response("nope", { status: 500 });
            }
            delivered.push("restart");
            return new Response("ok", { status: 200 });
          }
          if (body.includes('"action":"failed"')) {
            delivered.push("failed");
          }
          return new Response("ok", { status: 200 });
        },
      ) as unknown as typeof globalThis.fetch;

      connection = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        requestRestart: () => {
          // What the handler does when the replacement cannot be built: the
          // connect rejects and it retracts the verdict it already announced.
          connection.reportFailedStallRestart();
        },
      });
      config.baileys.sendStallRestartEnabled = true;
      const key = clusterKeys.sendStall("+5511999999999");

      try {
        await connectOpen();
        wedge();
        const start = Date.now();

        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        setSystemTime(new Date(start + 120_000));
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await new Promise((r) => setTimeout(r, 20));

        expect(delivered).toEqual(["restart", "failed"]);
      } finally {
        globalThis.fetch = outerFetch;
        config.webhook.retryPolicy.maxRetries = outerRetries;
        setSystemTime();
        await redis.del(key);
      }
    });

    // isDiscarded is set by an ordinary replacement too -- a POST /restart, the
    // lease fence, a respawn -- and those keep the session. Treating them like a
    // logout wipes the phone's whole 24h history and hands it a clean backoff
    // slate that an earlier genuine stall already spent.
    it("keeps the earlier history when the socket is merely replaced", async () => {
      const restarts: string[] = [];
      connection = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        requestRestart: (reason: string) => restarts.push(reason),
      });
      config.baileys.sendStallRestartEnabled = true;
      const key = clusterKeys.sendStall("+5511999999999");
      await redis.set(
        key,
        JSON.stringify({ restarts: 1, nextRestartAllowedAt: Date.now() - 1 }),
      );

      await connectOpen();
      wedge();

      interceptStrikeWrite(() => {
        // A concurrent POST /restart discards this socket and spawns its
        // replacement. The session lives on; only this socket is gone.
        (connection as unknown as { isDiscarded: boolean }).isDiscarded = true;
      });

      try {
        const start = Date.now();
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        setSystemTime(new Date(start + 120_000));
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await new Promise((r) => setTimeout(r, 5));

        expect(restarts.length).toBe(0);
        // Our increment is taken back; the phone's earlier strike stays.
        expect(JSON.parse((await redis.get(key)) ?? "{}").restarts).toBe(1);
      } finally {
        setSystemTime();
        await redis.del(key);
      }
    });

    // The strike is what turns "restarting is not curing this" into "give up and
    // let the operator see it". Restarting anyway when it cannot be written means
    // a phone that keeps stalling restarts on every episode for as long as Redis
    // is unreachable -- and a Redis outage is fleet-wide, so that is every
    // stalled inbox looping while the system is already degraded.
    it("suppresses the restart when the strike cannot be written", async () => {
      const restarts: string[] = [];
      connection = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        requestRestart: (reason: string) => restarts.push(reason),
      });
      config.baileys.sendStallRestartEnabled = true;
      const record = spyOn(sendStallStore, "recordRestart").mockRejectedValue(
        new Error("redis down"),
      );

      try {
        await connectOpen();
        wedge();
        const start = Date.now();

        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        setSystemTime(new Date(start + 120_000));
        fetchCalls.length = 0;
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await new Promise((r) => setTimeout(r, 5));

        expect(record).toHaveBeenCalledTimes(1);
        expect(restarts.length).toBe(0);
        const verdicts = fetchCalls
          .filter((call) => call.body.includes("send_stall_detected"))
          .map((call) => JSON.parse(call.body).data.sendStall.action);
        expect(verdicts).toEqual(["suppressed"]);

        // Re-armed on the cooldown, so the connection is due for review again
        // rather than muted for the life of the socket. The process-wide restart
        // slot is separate state on the class and runs on performance.now(),
        // which setSystemTime does not move, so it has to be released by hand or
        // the second episode is merely deferred instead of re-evaluated.
        (
          BaileysConnection as unknown as { lastStallRestartAt: number }
        ).lastStallRestartAt = Number.NEGATIVE_INFINITY;
        setSystemTime(new Date(start + 200_000));
        await expect(send()).rejects.toThrow(BaileysSendStalledError);
        await new Promise((r) => setTimeout(r, 5));
        expect(
          fetchCalls.filter((call) => call.body.includes("send_stall_detected"))
            .length,
        ).toBe(2);
      } finally {
        record.mockRestore();
        setSystemTime();
        await redis.del(clusterKeys.sendStall("+5511999999999"));
      }
    });

    // The verdicts are chained, so the delivery starts a microtask later --
    // while requestRestart discards this connection synchronously. The handler
    // reads inFlightWebhooks at exactly that moment to decide whether to hold the
    // old connection open for a graceful shutdown, so the queued verdict has to
    // be counted before the chain runs, not when it does.
    it("counts a queued verdict as in flight before the discard sees it", async () => {
      let inFlightAtRestart = -1;
      connection = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        requestRestart: () => {
          // The handler's forceRestart branch, at the line that decides whether
          // this connection joins drainingWebhooks.
          inFlightAtRestart = connection.inFlightWebhooks;
        },
      });
      config.baileys.sendStallRestartEnabled = true;
      const key = clusterKeys.sendStall("+5511999999999");

      try {
        await connectOpen();
        wedge();
        const start = Date.now();

        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        setSystemTime(new Date(start + 120_000));
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await new Promise((r) => setTimeout(r, 5));

        expect(inFlightAtRestart).toBeGreaterThan(0);
        // And it comes back down, or a graceful shutdown would wait forever.
        expect(connection.inFlightWebhooks).toBe(0);
      } finally {
        setSystemTime();
        await redis.del(key);
      }
    });

    // A Redis lookup can outlive the episode that started it. An in-place
    // reconnect keeps THIS object and only bumps the generation, so a cooldown
    // written from the failure path lands on the new socket's detector and mutes
    // it for a stall it never had, while the `suppressed` verdict describes an
    // episode that is already over.
    it("drops a stale episode when the backoff lookup fails after recovery", async () => {
      const restarts: string[] = [];
      connection = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        requestRestart: (reason: string) => restarts.push(reason),
      });
      config.baileys.sendStallRestartEnabled = true;
      const key = clusterKeys.sendStall("+5511999999999");
      const canRestart = spyOn(sendStallStore, "canRestart").mockImplementation(
        async () => {
          // Recovery lands while the lookup is in flight, and only then does the
          // lookup fail.
          await mockEventHandlers.get("connection.update")?.({
            connection: "open",
          });
          throw new Error("redis down");
        },
      );

      try {
        await connectOpen();
        wedge();
        const start = Date.now();

        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        setSystemTime(new Date(start + 120_000));
        fetchCalls.length = 0;
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await new Promise((r) => setTimeout(r, 5));

        const stallCalls = () =>
          fetchCalls.filter((call) => call.body.includes("send_stall_detected"))
            .length;
        // Nothing reported: the episode this verdict would describe is over.
        expect(stallCalls()).toBe(0);
        expect(restarts.length).toBe(0);

        // And the detector is not muted. The silence went back to 0, so a fresh
        // episode on the recovered socket reports itself instead of waiting out
        // a cooldown it did not earn.
        canRestart.mockRestore();
        const second = Date.now();
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        setSystemTime(new Date(second + 120_000));
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await new Promise((r) => setTimeout(r, 5));

        expect(stallCalls()).toBe(1);
      } finally {
        canRestart.mockRestore();
        setSystemTime();
        await redis.del(key);
      }
    });

    // The backoff key is per phone number and outlives the session by up to 24h,
    // so a strike written while this session is being torn down is inherited by
    // whatever is paired on that number next -- its watchdog suppressed on the
    // strength of a socket that no longer exists. The coordinator DELs the key in
    // logout's finally, and the store is a plain read-modify-write, so a write
    // that straddles the DEL simply recreates it.
    it("does not leave a stall strike behind for a session being discarded", async () => {
      const restarts: string[] = [];
      connection = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        requestRestart: (reason: string) => restarts.push(reason),
      });
      config.baileys.sendStallRestartEnabled = true;
      await connectOpen();
      wedge();

      // Logout landing inside the write, which is the only window the pre-check
      // cannot see: it sets isDiscarded before its first await, and the
      // coordinator DELs this key in its finally.
      const key = clusterKeys.sendStall("+5511999999999");
      // The preload's redis.set is itself a mock, and laying a spyOn over one is
      // the pattern that leaks across spec files here. Use its own one-shot API
      // and write straight into the fake's store.
      const setKeys = interceptStrikeWrite(() => {
        (connection as unknown as { isDiscarded: boolean }).isDiscarded = true;
      });

      try {
        const start = Date.now();
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        setSystemTime(new Date(start + 120_000));
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await asyncSleep(0);

        // Guards the stub itself: if some other write came first, the fence was
        // never exercised and the rest of this example would prove nothing.
        expect(setKeys).toEqual([key]);
        expect(await redis.get(key)).toBe(null);
        // And the restart is abandoned with it: the session is going away.
        expect(restarts.length).toBe(0);
      } finally {
        setSystemTime();
        await redis.del(key);
      }
    });

    // The strike stands for a restart. If recovery lands while the write is in
    // flight, the handler's own guard vetoes the restart -- and a strike left
    // behind then suppresses the NEXT genuine stall for five minutes on the
    // strength of a connection that healed itself.
    it("rolls the strike back when recovery cancels the restart", async () => {
      const restarts: string[] = [];
      connection = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        requestRestart: (reason: string) => restarts.push(reason),
      });
      config.baileys.sendStallRestartEnabled = true;
      await connectOpen();
      wedge();

      const key = clusterKeys.sendStall("+5511999999999");
      const setKeys = interceptStrikeWrite(async () => {
        // A genuine recovery signal, not a hand-cleared flag: `open` is a new
        // socket, and clearing the stall is what withdraws the restart.
        await mockEventHandlers.get("connection.update")?.({
          connection: "open",
        });
      });

      try {
        const start = Date.now();
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        setSystemTime(new Date(start + 120_000));
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await asyncSleep(0);

        expect(setKeys).toEqual([key]);
        expect(await redis.get(key)).toBe(null);
        expect(restarts.length).toBe(0);
      } finally {
        setSystemTime();
        await redis.del(key);
      }
    });

    // The other way a restart gets called off, and it undoes differently. This
    // veto is issued by the handler AFTER it drains the per-number slot, so an
    // explicit logout queued ahead of the restart is exactly what produces it:
    // by then the session is gone and the coordinator has DELed the backoff key
    // in its finally. Restoring the previous episode's value would recreate it
    // for a session that no longer exists, and hand it to whatever is paired on
    // this number next.
    it("does not resurrect the backoff when a logout is what vetoed the restart", async () => {
      const key = clusterKeys.sendStall("+5511999999999");
      const stringData = (
        redis as unknown as { __stringData: Map<string, string> }
      ).__stringData;
      // An earlier genuine episode, already past its backoff window.
      stringData.set(
        key,
        JSON.stringify({ restarts: 1, nextRestartAllowedAt: Date.now() - 1 }),
      );

      const restarts: string[] = [];
      connection = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        requestRestart: (reason: string) => restarts.push(reason),
      });
      config.baileys.sendStallRestartEnabled = true;
      await connectOpen();
      wedge();

      try {
        const start = Date.now();
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        setSystemTime(new Date(start + 120_000));
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await asyncSleep(0);

        expect(restarts.length).toBe(1);
        expect(JSON.parse(stringData.get(key) ?? "{}").restarts).toBe(2);

        // The logout that was holding the handler's slot runs: it ends the
        // session, and close() DELs this key on the way out.
        Object.assign(connection as unknown as Record<string, unknown>, {
          isDiscarded: true,
          sessionEnded: true,
        });
        stringData.delete(key);

        // The handler drains, sees the connection is no longer registered, and
        // vetoes the restart it had queued.
        await connection.withdrawStallRestart();

        expect(await redis.get(key)).toBe(null);
      } finally {
        setSystemTime();
        await redis.del(key);
      }
    });

    // `action` is documented as whether the socket was recreated, and everything
    // after the decision can still call the restart off. Announcing "restart" up
    // front tells a consumer recovery is underway when it may never start.
    it("does not announce a restart it has not committed to", async () => {
      const restarts: string[] = [];
      connection = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        requestRestart: (reason: string) => restarts.push(reason),
      });
      config.baileys.sendStallRestartEnabled = true;
      await connectOpen();
      wedge();

      const key = clusterKeys.sendStall("+5511999999999");
      interceptStrikeWrite(async () => {
        // Recovery lands while the strike is being written.
        await mockEventHandlers.get("connection.update")?.({
          connection: "open",
        });
      });

      try {
        const start = Date.now();
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        setSystemTime(new Date(start + 120_000));
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await asyncSleep(0);

        expect(restarts.length).toBe(0);
        // Nothing was announced either: no restart happened, and the episode was
        // never suppressed by a backoff, so there is no verdict to report.
        expect(
          fetchCalls.filter((call) => call.body.includes("send_stall_detected"))
            .length,
        ).toBe(0);
      } finally {
        setSystemTime();
        await redis.del(key);
      }
    });

    // The coordinator clears this key in logoutWithLease, but that is one of
    // several destructive paths: admin logoutAll, the wrong-number
    // requestLogout and a remote `loggedOut` close all go through close()
    // instead. The key is per phone number and lives 24h, so whatever is paired
    // on that number next inherits a suppression it never earned.
    it("clears the stall backoff when the session is torn down", async () => {
      const key = clusterKeys.sendStall("+5511999999999");
      await redis.set(
        key,
        JSON.stringify({ restarts: 3, nextRestartAllowedAt: Date.now() + 1e6 }),
      );

      await connectOpen();
      // Through a real destructive path rather than the private close() it
      // funnels into, so the example still means something if that plumbing
      // changes.
      await connection.logout();

      expect(await redis.get(key)).toBe(null);
    });

    // Discarded and recovered undo differently. A torn-down session's logout
    // DELETES this key, so restoring the previous episode's value resurrects a
    // backoff for a session that no longer exists and hands it to the next
    // pairing on this number.
    it("does not resurrect an old backoff when the session is discarded", async () => {
      const restarts: string[] = [];
      connection = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        requestRestart: (reason: string) => restarts.push(reason),
      });
      config.baileys.sendStallRestartEnabled = true;
      const key = clusterKeys.sendStall("+5511999999999");
      // An earlier genuine episode, which is what makes `previous` non-null.
      await redis.set(
        key,
        JSON.stringify({ restarts: 1, nextRestartAllowedAt: Date.now() - 1 }),
      );

      await connectOpen();
      wedge();

      interceptStrikeWrite(() => {
        // Logout landing inside the write: it marks the session ended and
        // discards before its first await, and close() DELs this key.
        Object.assign(connection as unknown as Record<string, unknown>, {
          isDiscarded: true,
          sessionEnded: true,
        });
      });

      try {
        const start = Date.now();
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        setSystemTime(new Date(start + 120_000));
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await asyncSleep(0);

        expect(await redis.get(key)).toBe(null);
        expect(restarts.length).toBe(0);
      } finally {
        setSystemTime();
        await redis.del(key);
      }
    });

    // A terminal `loggedOut` close lands while the strike is being written. It
    // destroys the auth state, so rebuilding a socket afterwards would pair a
    // fresh QR session conjured out of a logout -- and until close() marked
    // itself, this connection still looked live enough to ask for one.
    it("does not restart into a session that was just logged out", async () => {
      const restarts: string[] = [];
      connection = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        requestRestart: (reason: string) => restarts.push(reason),
      });
      config.baileys.sendStallRestartEnabled = true;
      await connectOpen();
      wedge();

      const key = clusterKeys.sendStall("+5511999999999");
      interceptStrikeWrite(async () => {
        await mockEventHandlers.get("connection.update")?.({
          connection: "close" as const,
          lastDisconnect: {
            error: { output: { statusCode: 401, payload: {} }, message: "x" },
          },
        });
      });

      try {
        const start = Date.now();
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        setSystemTime(new Date(start + 120_000));
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await asyncSleep(0);

        expect(restarts.length).toBe(0);
        // And the backoff goes with the session rather than being restored for
        // whatever pairs on this number next.
        expect(await redis.get(key)).toBe(null);
      } finally {
        setSystemTime();
        await redis.del(key);
      }
    });

    // Without this, the breaker stays open across an in-place reconnect (the
    // connection object survives a socket drop) and the connection answers 503
    // forever — worse than the original stall, which at least cleared itself
    // when WhatsApp dropped the socket.
    it("reopens the circuit when the connection opens again", async () => {
      await connectOpen();
      wedge();
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(BaileysSendStalledError);

      mockSocket.sendMessage.mockImplementation(async () => ({
        key: { id: "msg-id" },
      }));
      await mockEventHandlers.get("connection.update")?.({
        connection: "open",
      });

      expect(connection.consecutiveSendTimeouts).toBe(0);
      await expect(send()).resolves.toBeDefined();
    });

    // Media generation and upload run inside socket.sendMessage BEFORE the
    // keystore mutex, so three slow uploads open the breaker with the mutex
    // perfectly free. Without this the breaker could only ever open: once it is
    // rejecting, no send reaches the socket, so the success that would close it
    // can never happen and the connection answers 503 until it reconnects.
    it("reopens the circuit when an abandoned send finally completes", async () => {
      await connectOpen();
      let release: ((value: { key: { id: string } }) => void) | undefined;
      mockSocket.sendMessage.mockImplementation(
        () =>
          new Promise<{ key: { id: string } }>((resolve) => {
            release = resolve;
          }),
      );

      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      expect(connection.sendState).toBe("stalled");

      // The abandoned upload lands: the socket was never wedged.
      release?.({ key: { id: "msg-id" } });
      await asyncSleep(0);

      expect(connection.consecutiveSendTimeouts).toBe(0);
      expect(connection.sendState).toBe("ok");
      mockSocket.sendMessage.mockImplementation(async () => ({
        key: { id: "msg-id" },
      }));
      await expect(send()).resolves.toBeDefined();
    });

    // The backoff branch advertises an `until` to the client. Staying silent past
    // it would make that timestamp a lie: the breaker rejects every send without
    // touching the socket, so nothing else brings the connection back up for
    // review and it would sit muted for the life of the socket.
    it("reconsiders the episode once the advertised backoff expires", async () => {
      connection = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        requestRestart: () => {},
      });
      config.baileys.sendStallRestartEnabled = true;
      const start = Date.now();
      // Already backed off: a restart is not allowed until start + 300s.
      await redis.set(
        clusterKeys.sendStall("+5511999999999"),
        JSON.stringify({
          restarts: 1,
          nextRestartAllowedAt: start + 300_000,
        }),
      );
      await connectOpen();
      wedge();

      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      setSystemTime(new Date(start + 120_000));
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await asyncSleep(0);

      const first = fetchCalls.filter((call) =>
        call.body.includes("send_stall_detected"),
      );
      expect(first.length).toBe(1);
      expect(JSON.parse(first[0]?.body ?? "{}").data.sendStall.action).toBe(
        "suppressed",
      );

      // Still inside the advertised window: nothing new to say.
      setSystemTime(new Date(start + 200_000));
      await expect(send()).rejects.toThrow(BaileysSendStalledError);
      await asyncSleep(0);
      expect(
        fetchCalls.filter((call) => call.body.includes("send_stall_detected"))
          .length,
      ).toBe(1);

      // Past it: the connection is due for review again. Waited for rather than
      // timed: the breaker now rejects before any of the send-path work, so the
      // caller's rejection arrives ahead of the episode the rejection triggered.
      setSystemTime(new Date(start + 400_000));
      await expect(send()).rejects.toThrow(BaileysSendStalledError);
      const stallWebhooks = () =>
        fetchCalls.filter((call) => call.body.includes("send_stall_detected"))
          .length;
      for (let i = 0; i < 50 && stallWebhooks() < 2; i += 1) {
        await asyncSleep(1);
      }
      expect(stallWebhooks()).toBe(2);

      setSystemTime();
      await redis.del(clusterKeys.sendStall("+5511999999999"));
    });

    // maybeReportSendStall raises the silence to Infinity before launching the
    // async verdict, so anything that returns without lowering it mutes the
    // connection for the life of the socket: the breaker rejects every later send
    // without touching the socket, so nothing else would ever bring it back up for
    // review, and the restart it needed is never requested.
    it("re-arms the episode when the backoff lookup fails", async () => {
      connection = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        requestRestart: () => {},
      });
      config.baileys.sendStallRestartEnabled = true;
      const canRestart = spyOn(sendStallStore, "canRestart").mockRejectedValue(
        new Error("redis down"),
      );
      const start = Date.now();

      try {
        await connectOpen();
        wedge();

        // Real timers, not asyncSleep(0): the verdicts are chained, so a second
        // one is not even dispatched until the first delivery settles.
        const settle = () => new Promise((r) => setTimeout(r, 5));

        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        setSystemTime(new Date(start + 120_000));
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await settle();

        const stallCalls = () =>
          fetchCalls.filter((call) => call.body.includes("send_stall_detected"))
            .length;
        expect(stallCalls()).toBe(1);

        // Inside the cooldown the failure does not become a webhook per send.
        setSystemTime(new Date(start + 130_000));
        await expect(send()).rejects.toThrow(BaileysSendStalledError);
        await settle();
        expect(stallCalls()).toBe(1);

        // Past it, the connection is due for review again.
        setSystemTime(new Date(start + 200_000));
        await expect(send()).rejects.toThrow(BaileysSendStalledError);
        await settle();
        expect(stallCalls()).toBe(2);
      } finally {
        canRestart.mockRestore();
        setSystemTime();
      }
    });

    // A socket still handshaking is not a wedged one. Sends that time out while a
    // first connect or a slow reconnect is in flight are an ordinary outage, and
    // tearing the socket down for them would do it again on the replacement.
    it("does not call a still-connecting socket stalled", async () => {
      config.baileys.sendStallRestartEnabled = true;
      const restarts: string[] = [];
      connection = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        requestRestart: (reason: string) => restarts.push(reason),
      });
      await connection.connect();
      // No `connection: "open"` — the socket object exists, the handshake does not.
      wedge();
      fetchCalls.length = 0;
      const start = Date.now();

      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      setSystemTime(new Date(start + 120_000));
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await asyncSleep(0);

      expect(
        fetchCalls.filter((call) => call.body.includes("send_stall_detected"))
          .length,
      ).toBe(0);
      expect(restarts.length).toBe(0);
      setSystemTime();
    });

    // Every await inside handleSendStall is a window in which WhatsApp can drop and
    // remake the socket on its own. The replacement gets a fresh keystore and clears
    // the breaker, so acting on the verdict afterwards means reporting a stall on a
    // healthy connection and asking the handler to throw it away.
    it("abandons the episode when the socket is replaced while the backoff is read", async () => {
      const restarts: string[] = [];
      connection = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        requestRestart: (reason: string) => restarts.push(reason),
      });
      config.baileys.sendStallRestartEnabled = true;
      const canRestart = spyOn(sendStallStore, "canRestart").mockImplementation(
        async () => {
          // WhatsApp remade the socket while Redis was answering.
          (
            connection as unknown as { socketGeneration: number }
          ).socketGeneration += 1;
          (
            connection as unknown as { _consecutiveSendTimeouts: number }
          )._consecutiveSendTimeouts = 0;
          return true;
        },
      );
      const start = Date.now();

      try {
        await connectOpen();
        wedge();
        fetchCalls.length = 0;

        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        setSystemTime(new Date(start + 120_000));
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await asyncSleep(0);

        expect(
          fetchCalls.filter((call) => call.body.includes("send_stall_detected"))
            .length,
        ).toBe(0);
        expect(restarts.length).toBe(0);
      } finally {
        canRestart.mockRestore();
        setSystemTime();
      }
    });

    // The entry gate checks isOpen, but the verdict is decided after two Redis
    // round trips. A socket that emits `close` in that window still matches on
    // generation and streak, so without carrying the gate across the awaits an
    // ordinary disconnect is reported as a stall, spends a backoff strike and
    // asks for a restart of something already reconnecting on its own.
    it("abandons the episode when the socket closes while the backoff is read", async () => {
      const restarts: string[] = [];
      connection = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        requestRestart: (reason: string) => restarts.push(reason),
      });
      config.baileys.sendStallRestartEnabled = true;
      const canRestart = spyOn(sendStallStore, "canRestart").mockImplementation(
        async () => {
          // WhatsApp dropped the socket while Redis was answering.
          (
            connection as unknown as { connectionState: string }
          ).connectionState = "close";
          return true;
        },
      );
      const start = Date.now();

      try {
        await connectOpen();
        wedge();
        fetchCalls.length = 0;

        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        setSystemTime(new Date(start + 120_000));
        await expect(send()).rejects.toThrow(OperationTimeoutError);
        await asyncSleep(0);

        expect(
          fetchCalls.filter((call) => call.body.includes("send_stall_detected"))
            .length,
        ).toBe(0);
        expect(restarts.length).toBe(0);
        expect(await redis.get(clusterKeys.sendStall("+5511999999999"))).toBe(
          null,
        );
      } finally {
        canRestart.mockRestore();
        setSystemTime();
      }
    });

    // The one that made the watchdog defeat itself in production. `isOnline` is
    // a presence echo on the socket we already have — sendPresenceUpdate emits
    // it, and POST /connections calls exactly that when it reuses a live
    // connection, which is what the Chatwoot health check does every five
    // minutes. Treating it as an open would hand a still-wedged socket a clean
    // breaker on a timer, and every reset lets another batch of sends queue
    // behind the same stuck mutex.
    it("does not reopen the circuit for a presence echo on the same socket", async () => {
      await connectOpen();
      wedge();
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      expect(connection.sendState).toBe("stalled");

      await mockEventHandlers.get("connection.update")?.({ isOnline: true });

      expect(connection.consecutiveSendTimeouts).toBe(3);
      expect(connection.sendState).toBe("stalled");
      await expect(send()).rejects.toThrow(BaileysSendStalledError);
    });

    // The mirror image: `withTimeout` cannot cancel, so deadlines armed against
    // the old socket keep running after it is replaced. Unstamped, three of
    // them expiring after the swap open the breaker on a replacement that never
    // refused a send.
    it("ignores timeouts left over from a socket that has been replaced", async () => {
      await connectOpen();
      wedge();

      // Three sends parked on the socket that is about to be thrown away.
      const parked = [send(), send(), send()].map((promise) =>
        promise.catch((error) => error),
      );

      await mockEventHandlers.get("connection.update")?.({
        connection: "close" as const,
        lastDisconnect: {
          error: {
            output: {
              statusCode: 500,
              payload: {
                statusCode: 500,
                error: "Unknown",
                message: "Stream Errored",
              },
            },
            message: "Stream Errored",
          },
        },
      });
      // The replacement socket is healthy.
      mockSocket.sendMessage.mockImplementation(async () => ({
        key: { id: "msg-id" },
      }));

      const settled = await Promise.all(parked);
      expect(
        settled.every((error) => error instanceof OperationTimeoutError),
      ).toBe(true);

      expect(connection.consecutiveSendTimeouts).toBe(0);
      await expect(send()).resolves.toBeDefined();
    });

    // A slow FAILING upload empties the mutex queue exactly like a slow
    // succeeding one. Reporting only late successes latches the breaker on a
    // connection where nothing is parked at all, and every later plain-text
    // send answers 503 until the socket is recreated.
    it("reopens the circuit when an abandoned send finally fails", async () => {
      await connectOpen();
      let reject: ((error: unknown) => void) | undefined;
      mockSocket.sendMessage.mockImplementation(
        () =>
          new Promise<never>((_, rej) => {
            reject = rej;
          }),
      );

      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      expect(connection.sendState).toBe("stalled");

      reject?.(new Error("upload failed"));
      await asyncSleep(0);

      // ONE slot back, not the whole queue: the rejection proves this operation
      // left, and media upload runs BEFORE the mutex is taken, so it says nothing
      // about whether the others are still queued behind a wedged one.
      expect(connection.consecutiveSendTimeouts).toBe(2);
      // The failure says an operation departed, NOT that a message went out, so the
      // health timestamp must stay untouched.
      expect(connection.lastSendCompletedAt).toBeNull();
      // And the freed slot is real: the next send reaches the socket instead of
      // being refused outright.
      mockSocket.sendMessage.mockClear();
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      expect(mockSocket.sendMessage.mock.calls.length).toBe(1);
    });

    // The exception that makes the rule safe: a rejection that IS the
    // transaction-mutex timeout reports a wedged mutex, not a freed one.
    // Closing the breaker on it sends the next batch straight back into the
    // queue the breaker exists to keep bounded.
    it("keeps the circuit open when an abandoned send fails on the transaction mutex", async () => {
      await connectOpen();
      let reject: ((error: unknown) => void) | undefined;
      mockSocket.sendMessage.mockImplementation(
        () =>
          new Promise<never>((_, rej) => {
            reject = rej;
          }),
      );

      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);
      await expect(send()).rejects.toThrow(OperationTimeoutError);

      reject?.(
        Object.assign(new Error("keystore transaction timed out"), {
          data: { key: "+5511999999999", code: "E_TX_MUTEX_TIMEOUT" },
        }),
      );
      await asyncSleep(0);

      expect(connection.consecutiveSendTimeouts).toBe(3);
      await expect(send()).rejects.toThrow(BaileysSendStalledError);
    });

    it("reports sendState unknown until a send has actually been observed", async () => {
      await connectOpen();
      expect(connection.sendState).toBe("unknown");
    });

    // markTraffic() fires on inbound traffic too, so it stays fresh while
    // sending is dead. Only WhatsApp acknowledging one of OUR messages proves
    // the send path end to end.
    it("records an outgoing ack from messages.update", async () => {
      await connectOpen();
      expect(connection.lastOutgoingAckAt).toBeNull();

      await connection.sendMessage(
        "jid@s.whatsapp.net",
        { text: "hi" },
        { messageId: "3EB0RESERVED" },
      );
      mockEventHandlers.get("messages.update")?.([
        { key: { fromMe: true, id: "3EB0RESERVED" }, update: { status: 2 } },
      ]);

      expect(connection.lastOutgoingAckAt).not.toBeNull();
    });

    // The send whose outcome we could not confirm is exactly the one whose
    // acknowledgement matters most, and it is the one that used to be
    // unmatchable: the success path that records Baileys' generated id never
    // ran, so every receipt for it was rejected as not ours and the only
    // end-to-end evidence there is stayed null. Reachable only without a
    // reserved messageId; with one the same id was tracked before the send left.
    it("matches acks for a send that only succeeded after timing out", async () => {
      config.baileys.sendTimeoutMs = 10;
      await connectOpen();
      expect(connection.lastOutgoingAckAt).toBeNull();

      mockSocket.sendMessage.mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ key: { id: "GENERATED-LATE" } }), 30),
          ),
      );
      await expect(
        connection.sendMessage("jid@s.whatsapp.net", { text: "hi" }),
      ).rejects.toThrow(OperationTimeoutError);

      // Real timers: asyncSleep is mocked in preload and would spin without ever
      // letting the 30ms settle fire.
      for (let i = 0; i < 50 && connection.lastSendCompletedAt === null; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(connection.lastSendCompletedAt).not.toBeNull();

      mockEventHandlers.get("messages.update")?.([
        { key: { fromMe: true, id: "GENERATED-LATE" }, update: { status: 2 } },
      ]);

      expect(connection.lastOutgoingAckAt).not.toBeNull();
      config.baileys.sendTimeoutMs = 45_000;
    });

    // The retroactive claim above is the whole reason isOurSubmittedKey has a side
    // effect, and it is why the status has to be read BEFORE it. An update that
    // is not an acknowledgement -- an ERROR status, or an edit carrying none --
    // would otherwise park its id, and the send that follows would claim it as
    // end-to-end proof. /health would then report delivery for a message
    // WhatsApp rejected, which is worse than reporting nothing.
    it("does not claim a failed update as an acknowledgement", async () => {
      await connectOpen();
      expect(connection.lastOutgoingAckAt).toBeNull();

      mockSocket.sendMessage.mockImplementationOnce(async () => {
        // WhatsApp answers while the send is still resolving -- but with a
        // rejection, and then with an update carrying no status at all.
        mockEventHandlers.get("messages.update")?.([
          {
            key: { fromMe: true, id: "GENERATED-FAILED" },
            update: { status: WAMessageStatus.ERROR },
          },
        ]);
        mockEventHandlers.get("messages.update")?.([
          { key: { fromMe: true, id: "GENERATED-FAILED" }, update: {} },
        ]);
        return { key: { id: "GENERATED-FAILED" } };
      });

      await connection.sendMessage("jid@s.whatsapp.net", { text: "hi" });

      // The send itself resolved, so sendState is legitimately `ok` -- that only
      // says the keystore mutex was free. lastOutgoingAckAt is the end-to-end
      // half, and nothing here earned it.
      expect(connection.lastOutgoingAckAt).toBeNull();

      // A real acknowledgement for the same message still lands, so this is not
      // passing by refusing everything.
      mockEventHandlers.get("messages.update")?.([
        {
          key: { fromMe: true, id: "GENERATED-FAILED" },
          update: { status: WAMessageStatus.SERVER_ACK },
        },
      ]);
      expect(connection.lastOutgoingAckAt).not.toBeNull();
    });

    // A parked ack can be claimed long after it arrived: the send it belongs to
    // may take the full send timeout to resolve, and other sends acknowledge in
    // between. Writing the older timestamp over the newer one makes /health
    // report a send path staler than it is -- a false alarm on the one signal
    // that does not come from us.
    it("does not roll the newest acknowledgement backwards", async () => {
      await connectOpen();

      let resolveFirst: ((value: unknown) => void) | undefined;
      mockSocket.sendMessage.mockImplementationOnce(() => {
        // WhatsApp acknowledges the first send before it resolves.
        mockEventHandlers.get("messages.update")?.([
          {
            key: { fromMe: true, id: "GENERATED-FIRST" },
            update: { status: WAMessageStatus.SERVER_ACK },
          },
        ]);
        return new Promise((resolve) => {
          resolveFirst = () => resolve({ key: { id: "GENERATED-FIRST" } });
        });
      });
      const first = connection.sendMessage("jid@s.whatsapp.net", {
        text: "one",
      });
      await new Promise((r) => setTimeout(r, 5));
      // Nothing claimed yet: the id is still unknown to us.
      expect(connection.lastOutgoingAckAt).toBeNull();

      // A second send goes out and is acknowledged, all while the first is still
      // resolving.
      await connection.sendMessage(
        "jid@s.whatsapp.net",
        { text: "two" },
        { messageId: "RESERVED-SECOND" },
      );
      mockEventHandlers.get("messages.update")?.([
        {
          key: { fromMe: true, id: "RESERVED-SECOND" },
          update: { status: WAMessageStatus.SERVER_ACK },
        },
      ]);
      const newest = connection.lastOutgoingAckAt;
      expect(newest).not.toBeNull();

      // Only now does the first send resolve and claim its parked ack.
      resolveFirst?.(undefined);
      await first;

      expect(connection.lastOutgoingAckAt).toBe(newest);
    });

    // A receipt with no timestamp on it is not an acknowledgement either.
    it("does not claim an empty receipt as an acknowledgement", async () => {
      await connectOpen();

      mockSocket.sendMessage.mockImplementationOnce(async () => {
        mockEventHandlers.get("message-receipt.update")?.([
          { key: { fromMe: true, id: "GENERATED-GROUP" }, receipt: {} },
        ]);
        return { key: { id: "GENERATED-GROUP" } };
      });

      await connection.sendMessage("group@g.us", { text: "hi" });

      expect(connection.lastOutgoingAckAt).toBeNull();

      mockEventHandlers.get("message-receipt.update")?.([
        {
          key: { fromMe: true, id: "GENERATED-GROUP" },
          receipt: { receiptTimestamp: 1 },
        },
      ]);
      expect(connection.lastOutgoingAckAt).not.toBeNull();
    });

    // Without a reserved id we only learn the generated one when
    // socket.sendMessage resolves, and WhatsApp can acknowledge before that --
    // the node is on the wire while the enclosing keystore transaction is still
    // committing. Discarding that ack leaves lastOutgoingAckAt null for a
    // message that was demonstrably delivered.
    it("claims an ack that arrived before the generated id was known", async () => {
      await connectOpen();
      expect(connection.lastOutgoingAckAt).toBeNull();

      mockSocket.sendMessage.mockImplementationOnce(async () => {
        // WhatsApp acknowledges while the send is still resolving.
        mockEventHandlers.get("messages.update")?.([
          {
            key: { fromMe: true, id: "GENERATED-EARLY" },
            update: { status: 2 },
          },
        ]);
        return { key: { id: "GENERATED-EARLY" } };
      });

      await connection.sendMessage("jid@s.whatsapp.net", { text: "hi" });

      expect(connection.lastOutgoingAckAt).not.toBeNull();
    });

    // A `fromMe` ack is not proof our send path works: it also covers messages
    // the operator sent from the phone itself. Holding one must not credit it.
    it("does not credit an ack for a message it never submitted", async () => {
      await connectOpen();

      mockEventHandlers.get("messages.update")?.([
        { key: { fromMe: true, id: "FROM-THE-PHONE" }, update: { status: 2 } },
      ]);

      expect(connection.lastOutgoingAckAt).toBeNull();
    });

    // Group delivery and read acknowledgements ride message-receipt.update, not
    // messages.update. Without this a connection that only writes to groups sits
    // at `unknown` forever no matter how many recipients confirmed.
    it("records an outgoing ack from a group receipt", async () => {
      await connectOpen();
      await connection.sendMessage(
        "group@g.us",
        { text: "hi" },
        { messageId: "3EB0GROUP" },
      );
      expect(connection.lastOutgoingAckAt).toBeNull();

      mockEventHandlers.get("message-receipt.update")?.([
        {
          key: { fromMe: true, id: "3EB0GROUP", remoteJid: "group@g.us" },
          receipt: { userJid: "5511@s.whatsapp.net", receiptTimestamp: 1 },
        },
      ]);

      expect(connection.lastOutgoingAckAt).not.toBeNull();
    });

    // The id history describes the socket that submitted them. A receipt for a
    // message the PREVIOUS socket sent would otherwise present end-to-end evidence
    // about a replacement that has sent nothing and may itself be wedged.
    it("stops honouring acks for ids the replaced socket submitted", async () => {
      await connectOpen();
      await connection.sendMessage(
        "jid@s.whatsapp.net",
        { text: "hi" },
        { messageId: "3EB0OLDSOCKET" },
      );

      // The reconnect path, minus its async scheduling: drop the socket and build
      // the replacement through the real connect(), which is what bumps the
      // generation and clears the history.
      (connection as unknown as { socket: unknown }).socket = null;
      await connectOpen();

      mockEventHandlers.get("messages.update")?.([
        { key: { fromMe: true, id: "3EB0OLDSOCKET" }, update: { status: 2 } },
      ]);

      expect(connection.lastOutgoingAckAt).toBeNull();

      // And the replacement can still prove itself on its own traffic.
      await connection.sendMessage(
        "jid@s.whatsapp.net",
        { text: "hi" },
        { messageId: "3EB0NEWSOCKET" },
      );
      mockEventHandlers.get("messages.update")?.([
        { key: { fromMe: true, id: "3EB0NEWSOCKET" }, update: { status: 2 } },
      ]);

      expect(connection.lastOutgoingAckAt).not.toBeNull();
    });

    // Any non-null timestamp makes sendState read `ok`, so a replacement socket
    // that has never sent anything would inherit the previous socket's health
    // report and hold it indefinitely — including one that is itself wedged.
    it("stops reporting healthy on the replaced socket's evidence", async () => {
      await connectOpen();
      await connection.sendMessage("jid@s.whatsapp.net", { text: "hi" });
      expect(connection.sendState).toBe("ok");

      (connection as unknown as { socket: unknown }).socket = null;
      await connectOpen();

      expect(connection.lastSendCompletedAt).toBeNull();
      expect(connection.lastOutgoingAckAt).toBeNull();
      expect(connection.sendState).toBe("unknown");
    });

    // `fromMe` is true for everything the account sends, including from the phone
    // and from other linked devices — none of which went through this socket's
    // keystore mutex. Counting those would let a busy account keep a wedged
    // connection reporting `ok`, which is the exact blindness this signal exists
    // to remove.
    it("ignores an ack for a message this socket never sent", async () => {
      await connectOpen();

      mockEventHandlers.get("messages.update")?.([
        {
          key: { fromMe: true, id: "SENT_FROM_THE_PHONE" },
          update: { status: 2 },
        },
      ]);

      expect(connection.lastOutgoingAckAt).toBeNull();
      expect(connection.sendState).toBe("unknown");
    });

    it("ignores status updates for messages that are not ours", async () => {
      await connectOpen();

      mockEventHandlers.get("messages.update")?.([
        { key: { fromMe: false, id: "x" }, update: { status: 2 } },
      ]);

      expect(connection.lastOutgoingAckAt).toBeNull();
    });
  });

  describe("#sendPresenceUpdate", () => {
    it("does not throw if socket has no me credentials", async () => {
      await connection.connect();
      const origMe = mockSocket.authState.creds.me;
      mockSocket.authState.creds.me = null as any;

      // Should return undefined without calling sendPresenceUpdate
      const result = connection.sendPresenceUpdate("available");
      expect(result).toBeUndefined();

      mockSocket.authState.creds.me = origMe;
    });

    it("calls socket sendPresenceUpdate", async () => {
      await connection.connect();
      mockSocket.sendPresenceUpdate.mockClear();
      await connection.sendPresenceUpdate("composing", "target@s.whatsapp.net");
      expect(mockSocket.sendPresenceUpdate).toHaveBeenCalledWith(
        "composing",
        "target@s.whatsapp.net",
      );
    });
  });

  describe("#readMessages", () => {
    it("throws BaileysNotConnectedError if not connected", () => {
      expect(() => connection.readMessages([])).toThrow(
        BaileysNotConnectedError,
      );
    });

    it("delegates to socket", async () => {
      await connection.connect();
      const keys = [{ id: "msg-1" }];
      await connection.readMessages(keys as any);
      expect(mockSocket.readMessages).toHaveBeenCalledWith(keys);
    });
  });

  // A `<phone>@lid` address is one callers build by appending the suffix to whatever id
  // they hold, and WhatsApp answers it with silence rather than an error -- which reads
  // downstream as a chat with no history left.
  describe("#fetchMessageHistory addressing", () => {
    const anchor = { id: "MSG", fromMe: false };

    beforeEach(async () => {
      await connection.connect();
      mockSocket.signalRepository.lidMapping.getPNForLID.mockClear();
      mockSocket.signalRepository.lidMapping.getLIDForPN.mockClear();
    });

    const fetchFrom = async (remoteJid: string) => {
      mockSocket.fetchMessageHistory.mockClear();
      await connection.fetchMessageHistory(50, { ...anchor, remoteJid }, 1000);
      return mockSocket.fetchMessageHistory.mock.calls.at(-1)?.[1].remoteJid;
    };

    it("keeps a LID the mapping store recognises", async () => {
      mockSocket.signalRepository.lidMapping.getPNForLID.mockResolvedValueOnce(
        "5517996808833:0@s.whatsapp.net",
      );

      expect(await fetchFrom("123583875535016@lid")).toBe(
        "123583875535016@lid",
      );
    });

    it("swaps a phone number wearing the LID suffix for its real LID", async () => {
      mockSocket.signalRepository.lidMapping.getPNForLID.mockResolvedValueOnce(
        null,
      );
      mockSocket.signalRepository.lidMapping.getLIDForPN.mockResolvedValueOnce(
        "167392323834034@lid",
      );

      expect(await fetchFrom("553499503261@lid")).toBe("167392323834034@lid");
    });

    it("leaves the address alone when neither direction is known", async () => {
      expect(await fetchFrom("999@lid")).toBe("999@lid");
    });

    it("does not look up an address that is not a LID", async () => {
      expect(await fetchFrom("553499503261@s.whatsapp.net")).toBe(
        "553499503261@s.whatsapp.net",
      );
      expect(
        mockSocket.signalRepository.lidMapping.getPNForLID,
      ).not.toHaveBeenCalled();
    });

    it("falls back to the address it was given when the store throws", async () => {
      mockSocket.signalRepository.lidMapping.getPNForLID.mockRejectedValueOnce(
        new Error("store down"),
      );

      expect(await fetchFrom("123583875535016@lid")).toBe(
        "123583875535016@lid",
      );
    });
  });

  describe("#chatModify", () => {
    it("throws BaileysNotConnectedError if not connected", () => {
      expect(() =>
        connection.chatModify({} as any, "jid@s.whatsapp.net"),
      ).toThrow(BaileysNotConnectedError);
    });

    it("delegates to socket", async () => {
      await connection.connect();
      mockSocket.chatModify.mockClear();
      await connection.chatModify(
        { markRead: true } as any,
        "jid@s.whatsapp.net",
      );
      expect(mockSocket.chatModify).toHaveBeenCalledWith(
        { markRead: true },
        "jid@s.whatsapp.net",
      );
    });
  });

  describe("#deleteMessage", () => {
    it("sends a delete message via the socket", async () => {
      await connection.connect();
      mockSocket.sendMessage.mockClear();
      await connection.deleteMessage("jid@s.whatsapp.net", {
        id: "msg-1",
      } as any);
      expect(mockSocket.sendMessage).toHaveBeenCalledWith(
        "jid@s.whatsapp.net",
        { delete: { id: "msg-1" } },
      );
    });
  });

  describe("#editMessage", () => {
    it("sends an edit message via the socket", async () => {
      await connection.connect();
      mockSocket.sendMessage.mockClear();
      await connection.editMessage(
        "jid@s.whatsapp.net",
        { id: "msg-1" },
        { text: "edited" },
      );
      expect(mockSocket.sendMessage).toHaveBeenCalledWith(
        "jid@s.whatsapp.net",
        { text: "edited", edit: { id: "msg-1" } },
      );
    });
  });

  describe("#profilePictureUrl", () => {
    it("delegates to socket", async () => {
      await connection.connect();
      mockSocket.profilePictureUrl.mockClear();
      const _url = await connection.profilePictureUrl(
        "jid@s.whatsapp.net",
        "image",
      );
      expect(mockSocket.profilePictureUrl).toHaveBeenCalledWith(
        "jid@s.whatsapp.net",
        "image",
      );
    });
  });

  describe("#onWhatsApp", () => {
    it("delegates to socket", async () => {
      await connection.connect();
      await connection.onWhatsApp(["5521888@s.whatsapp.net"]);
      expect(mockSocket.onWhatsApp).toHaveBeenCalledWith(
        "5521888@s.whatsapp.net",
      );
    });
  });

  describe("#getReachoutTimelock", () => {
    it("throws BaileysNotConnectedError if not connected", () => {
      expect(() => connection.getReachoutTimelock()).toThrow(
        BaileysNotConnectedError,
      );
    });

    it("delegates to socket.fetchAccountReachoutTimelock", async () => {
      await connection.connect();
      const result = (await connection.getReachoutTimelock()) as any;
      expect(mockSocket.fetchAccountReachoutTimelock).toHaveBeenCalled();
      expect(result).toEqual({ isActive: false, enforcementType: "DEFAULT" });
    });
  });

  describe("#getNewChatMessageCap", () => {
    it("throws BaileysNotConnectedError if not connected", () => {
      expect(() => connection.getNewChatMessageCap()).toThrow(
        BaileysNotConnectedError,
      );
    });

    it("delegates to socket.fetchNewChatMessageCap", async () => {
      await connection.connect();
      const result = (await connection.getNewChatMessageCap()) as any;
      expect(mockSocket.fetchNewChatMessageCap).toHaveBeenCalled();
      expect(result).toEqual({
        total_quota: 100,
        used_quota: 0,
        capping_status: "NONE",
      });
    });
  });

  describe("#updateOptions", () => {
    it("updates connection options", () => {
      connection.updateOptions({
        webhookUrl: "https://new-hook.com",
        webhookVerifyToken: "new-token",
        clientName: "Firefox",
        groupsEnabled: true,
      });
      // No direct assertion on private fields — we verify it doesn't throw
    });

    it("persists metadata to Redis on update", async () => {
      await connection.updateOptions({
        webhookUrl: "https://new-hook.com",
        webhookVerifyToken: "new-token",
        groupsEnabled: false,
        apiKeyHash: "abc123",
      });
      const stored = (redis as any).__hashData
        .get("@baileys-api:connections:+5511999999999:authState")
        ?.get("metadata");
      expect(stored).toContain('"apiKeyHash":"abc123"');
    });

    it("rejects the metadata write when the lease is owned elsewhere", async () => {
      // updateOptions on a connection whose lease moved must not overwrite
      // the new owner's metadata (write-if-owner fence in persistMetadata).
      const authKey = "@baileys-api:connections:+5511999999999:authState";
      (redis as any).__hashData.set(
        authKey,
        new Map([["metadata", JSON.stringify({ webhookUrl: "current" })]]),
      );
      (redis as any).__stringData.set(
        "@baileys-api:cluster:lease:+5511999999999",
        JSON.stringify({ owner: "someone-else", epoch: 9 }),
      );

      await connection.updateOptions({
        webhookUrl: "https://stale-hook.com",
        webhookVerifyToken: "new-token",
      });

      expect((redis as any).__hashData.get(authKey)?.get("metadata")).toBe(
        JSON.stringify({ webhookUrl: "current" }),
      );
    });

    it("starts group activity flush when groupsEnabled switches to false on active connection", async () => {
      await connection.connect();

      // Switch to groupsEnabled=false on the live connection
      connection.updateOptions({
        webhookUrl: "https://example.com/webhook",
        webhookVerifyToken: "test-token",
        groupsEnabled: false,
      });

      // Simulate a group message — it should be diverted to the activity map
      const handler = mockEventHandlers.get("messages.upsert");
      expect(handler).toBeDefined();

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("ok", { status: 200 })),
      ) as any;

      await handler!({
        type: "notify",
        messages: [
          {
            key: { remoteJid: "group@g.us", id: "msg1" },
            message: { conversation: "hello" },
          },
        ],
      });

      // The group message should NOT have been sent as messages.upsert webhook
      const webhookCalls = (globalThis.fetch as any).mock.calls;
      const upsertCalls = webhookCalls.filter((c: any) => {
        const body = JSON.parse(c[1].body);
        return body.event === "messages.upsert";
      });
      expect(upsertCalls).toHaveLength(0);

      globalThis.fetch = originalFetch;
    });
  });

  describe("group methods", () => {
    beforeEach(async () => {
      await connection.connect();
    });

    it("#groupMetadata delegates to socket", async () => {
      await connection.groupMetadata("group@g.us");
      expect(mockSocket.groupMetadata).toHaveBeenCalledWith("group@g.us");
    });

    it("#groupParticipants delegates to socket", async () => {
      await connection.groupParticipants(
        "group@g.us",
        ["user@s.whatsapp.net"],
        "add",
      );
      expect(mockSocket.groupParticipantsUpdate).toHaveBeenCalledWith(
        "group@g.us",
        ["user@s.whatsapp.net"],
        "add",
      );
    });

    it("#groupCreate delegates to socket", async () => {
      await connection.groupCreate("My Group", ["user@s.whatsapp.net"]);
      expect(mockSocket.groupCreate).toHaveBeenCalledWith("My Group", [
        "user@s.whatsapp.net",
      ]);
    });

    it("#groupLeave delegates to socket", async () => {
      await connection.groupLeave("group@g.us");
      expect(mockSocket.groupLeave).toHaveBeenCalledWith("group@g.us");
    });

    it("#groupUpdateSubject delegates to socket", async () => {
      await connection.groupUpdateSubject("group@g.us", "New Name");
      expect(mockSocket.groupUpdateSubject).toHaveBeenCalledWith(
        "group@g.us",
        "New Name",
      );
    });

    it("#groupUpdateDescription delegates to socket", async () => {
      await connection.groupUpdateDescription("group@g.us", "desc");
      expect(mockSocket.groupUpdateDescription).toHaveBeenCalledWith(
        "group@g.us",
        "desc",
      );
    });

    it("#groupInviteCode delegates to socket", async () => {
      await connection.groupInviteCode("group@g.us");
      expect(mockSocket.groupInviteCode).toHaveBeenCalledWith("group@g.us");
    });

    it("#groupRevokeInvite delegates to socket", async () => {
      await connection.groupRevokeInvite("group@g.us");
      expect(mockSocket.groupRevokeInvite).toHaveBeenCalledWith("group@g.us");
    });

    it("#groupAcceptInvite delegates to socket", async () => {
      await connection.groupAcceptInvite("invite-code");
      expect(mockSocket.groupAcceptInvite).toHaveBeenCalledWith("invite-code");
    });

    it("#groupSettingUpdate delegates to socket", async () => {
      await connection.groupSettingUpdate("group@g.us", "locked");
      expect(mockSocket.groupSettingUpdate).toHaveBeenCalledWith(
        "group@g.us",
        "locked",
      );
    });

    it("#groupToggleEphemeral delegates to socket", async () => {
      await connection.groupToggleEphemeral("group@g.us", 86400);
      expect(mockSocket.groupToggleEphemeral).toHaveBeenCalledWith(
        "group@g.us",
        86400,
      );
    });

    it("#groupFetchAllParticipating delegates to socket", async () => {
      await connection.groupFetchAllParticipating();
      expect(mockSocket.groupFetchAllParticipating).toHaveBeenCalled();
    });
  });

  describe("Event Handlers", () => {
    beforeEach(async () => {
      await connection.connect();
    });

    describe("connection.update", () => {
      it("sends reconnecting state on isNewLogin", async () => {
        const handler = mockEventHandlers.get("connection.update")!;
        await handler({ isNewLogin: true });

        expect(fetchCalls.length).toBe(1);
        const body = JSON.parse(fetchCalls[0].body);
        expect(body.event).toBe("connection.update");
        expect(body.data.connection).toBe("reconnecting");
      });

      it("sends QR code data when qr is present", async () => {
        const handler = mockEventHandlers.get("connection.update")!;
        await handler({ qr: "qr-string-123" });

        expect(fetchCalls.length).toBe(1);
        const body = JSON.parse(fetchCalls[0].body);
        expect(body.data.connection).toBe("connecting");
        expect(body.data.qrDataUrl).toBe("data:image/png;base64,qrcode");
      });

      it("sends open state and resets reconnect count", async () => {
        const handler = mockEventHandlers.get("connection.update")!;
        await handler({ connection: "open", isOnline: true });

        expect(fetchCalls.length).toBe(1);
        const body = JSON.parse(fetchCalls[0].body);
        expect(body.data.connection).toBe("open");
      });

      it("sends the payload to the webhook URL", async () => {
        const handler = mockEventHandlers.get("connection.update")!;
        await handler({ connection: "open", isOnline: true });

        expect(fetchCalls[0].url).toBe("https://example.com/webhook");
        const body = JSON.parse(fetchCalls[0].body);
        expect(body.webhookVerifyToken).toBe("test-token");
      });

      it("forwards a standalone reachoutTimeLock update to the webhook", async () => {
        // fetchAccountReachoutTimelock emits connection.update carrying only
        // reachoutTimeLock (no connection state); it must fall through to the
        // webhook so the consumer gets the authoritative 463 restriction state.
        const handler = mockEventHandlers.get("connection.update")!;
        await handler({
          reachoutTimeLock: { isActive: true, enforcementType: "BIZ_QUALITY" },
        });

        expect(fetchCalls.length).toBe(1);
        const body = JSON.parse(fetchCalls[0].body);
        expect(body.event).toBe("connection.update");
        expect(body.data.reachoutTimeLock).toEqual({
          isActive: true,
          enforcementType: "BIZ_QUALITY",
        });
      });

      describe("connectionReplaced (440 conflict/replaced)", () => {
        const conflictClosePayload = {
          connection: "close" as const,
          lastDisconnect: {
            error: {
              output: {
                statusCode: 440,
                payload: {
                  statusCode: 440,
                  error: "Unknown",
                  message: "Stream Errored (conflict)",
                },
              },
              message: "Stream Errored (conflict)",
            },
          },
        };

        beforeEach(() => {
          (asyncSleep as any).mockClear();
        });

        it("reconnects without backoff on a single occurrence", async () => {
          const handler = mockEventHandlers.get("connection.update")!;
          await handler(conflictClosePayload);

          expect((asyncSleep as any).mock.calls.length).toBe(0);
        });

        it("backs off after 5 occurrences within the window", async () => {
          const handler = mockEventHandlers.get("connection.update")!;

          for (let i = 0; i < 4; i++) {
            await handler(conflictClosePayload);
          }
          expect((asyncSleep as any).mock.calls.length).toBe(0);

          await handler(conflictClosePayload);
          expect((asyncSleep as any).mock.calls.length).toBe(1);
          expect((asyncSleep as any).mock.calls[0][0]).toBe(30_000);
        });

        it("does not back off when events are spread beyond the sliding window", async () => {
          const handler = mockEventHandlers.get("connection.update")!;
          const base = Date.now();

          try {
            for (let i = 0; i < 4; i++) {
              setSystemTime(new Date(base + i * 1_000));
              await handler(conflictClosePayload);
            }
            expect((asyncSleep as any).mock.calls.length).toBe(0);

            // Jump past the window so the prior 4 timestamps are evicted.
            setSystemTime(new Date(base + 35_000));
            await handler(conflictClosePayload);

            expect((asyncSleep as any).mock.calls.length).toBe(0);
          } finally {
            setSystemTime();
          }
        });
      });
    });

    describe("messages.upsert", () => {
      it("sends message payload to webhook", async () => {
        const handler = mockEventHandlers.get("messages.upsert")!;
        await handler({
          type: "notify",
          messages: [
            {
              key: { id: "msg-1", remoteJid: "user@s.whatsapp.net" },
              message: { conversation: "hello" },
            },
          ],
        });

        expect(fetchCalls.length).toBe(1);
        const body = JSON.parse(fetchCalls[0].body);
        expect(body.event).toBe("messages.upsert");
      });
    });

    describe("messages.update", () => {
      it("sends update payload to webhook with awaitResponse", async () => {
        const handler = mockEventHandlers.get("messages.update")!;
        await handler([{ key: { id: "msg-1" }, update: {} }]);

        expect(fetchCalls.length).toBe(1);
        const body = JSON.parse(fetchCalls[0].body);
        expect(body.event).toBe("messages.update");
        expect(body.awaitResponse).toBe(true);
      });

      it("actively fetches the reachout timelock on a 463 update", async () => {
        // status ERROR (0) + '463' in messageStubParameters is how a 463
        // surfaces. We query the authoritative restriction state so a
        // connection.update { reachoutTimeLock } reaches the consumer.
        const handler = mockEventHandlers.get("messages.update")!;
        await handler([
          {
            key: { id: "msg-1", remoteJid: "user@s.whatsapp.net" },
            update: { status: 0, messageStubParameters: ["463"] },
          },
        ]);

        expect(mockSocket.fetchAccountReachoutTimelock).toHaveBeenCalledTimes(
          1,
        );
        // The messages.update itself is still forwarded.
        const body = JSON.parse(fetchCalls[0].body);
        expect(body.event).toBe("messages.update");
      });

      it("debounces a burst of 463 updates into a single fetch", async () => {
        const handler = mockEventHandlers.get("messages.update")!;
        await handler([
          {
            key: { id: "msg-1" },
            update: { status: 0, messageStubParameters: ["463"] },
          },
        ]);
        await handler([
          {
            key: { id: "msg-2" },
            update: { status: 0, messageStubParameters: ["463"] },
          },
        ]);

        expect(mockSocket.fetchAccountReachoutTimelock).toHaveBeenCalledTimes(
          1,
        );
      });

      it("does not fetch the reachout timelock for non-463 updates", async () => {
        const handler = mockEventHandlers.get("messages.update")!;
        // A delivery receipt (status SERVER_ACK) must not trigger the query.
        await handler([{ key: { id: "msg-1" }, update: { status: 2 } }]);

        expect(mockSocket.fetchAccountReachoutTimelock).not.toHaveBeenCalled();
      });
    });

    describe("message-receipt.update", () => {
      it("sends receipt update to webhook", async () => {
        const handler = mockEventHandlers.get("message-receipt.update")!;
        await handler([{ key: { id: "msg-1" }, receipt: {} }]);

        expect(fetchCalls.length).toBe(1);
        const body = JSON.parse(fetchCalls[0].body);
        expect(body.event).toBe("message-receipt.update");
      });
    });

    describe("groups.update", () => {
      it("sends group update to webhook", async () => {
        const handler = mockEventHandlers.get("groups.update")!;
        await handler([{ id: "group@g.us", subject: "New Name" }]);

        expect(fetchCalls.length).toBe(1);
        const body = JSON.parse(fetchCalls[0].body);
        expect(body.event).toBe("groups.update");
      });
    });

    describe("group-participants.update", () => {
      it("sends participant update to webhook", async () => {
        const handler = mockEventHandlers.get("group-participants.update")!;
        await handler({
          id: "group@g.us",
          participants: ["user@s.whatsapp.net"],
          action: "add",
        });

        expect(fetchCalls.length).toBe(1);
        const body = JSON.parse(fetchCalls[0].body);
        expect(body.event).toBe("group-participants.update");
      });
    });

    describe("message-capping.update", () => {
      it("forwards the capping update to the webhook (handled, not gated by listenToEvents)", async () => {
        // listenToEvents is empty in the test config, yet capping is delivered
        // because it is a first-class handled event, not a generic forwarded one.
        expect(config.baileys.listenToEvents.size).toBe(0);

        const handler = mockEventHandlers.get("message-capping.update")!;
        expect(handler).toBeDefined();

        await handler({
          total_quota: 100,
          used_quota: 95,
          capping_status: "SECOND_WARNING",
        });

        expect(fetchCalls.length).toBe(1);
        const body = JSON.parse(fetchCalls[0].body);
        expect(body.event).toBe("message-capping.update");
        expect(body.data.capping_status).toBe("SECOND_WARNING");
      });
    });
  });

  describe("#presenceSubscribe", () => {
    it("throws BaileysNotConnectedError if not connected", async () => {
      await expect(
        connection.presenceSubscribe(["user@s.whatsapp.net"]),
      ).rejects.toThrow(BaileysNotConnectedError);
    });

    it("calls socket.presenceSubscribe for each JID", async () => {
      await connection.connect();
      mockSocket.presenceSubscribe.mockClear();

      const result = await connection.presenceSubscribe([
        "user1@s.whatsapp.net",
        "user2@s.whatsapp.net",
      ]);

      expect(mockSocket.presenceSubscribe).toHaveBeenCalledTimes(2);
      expect(mockSocket.presenceSubscribe).toHaveBeenCalledWith(
        "user1@s.whatsapp.net",
      );
      expect(mockSocket.presenceSubscribe).toHaveBeenCalledWith(
        "user2@s.whatsapp.net",
      );
      expect(result.subscribed).toEqual([
        "user1@s.whatsapp.net",
        "user2@s.whatsapp.net",
      ]);
    });

    it("falls back to original JID when LID resolution fails", async () => {
      await connection.connect();
      mockSocket.presenceSubscribe.mockClear();
      mockSocket.signalRepository.lidMapping.getPNForLID.mockRejectedValueOnce(
        new Error("lookup failed"),
      );

      const result = await connection.presenceSubscribe([
        "999@lid",
        "user2@s.whatsapp.net",
      ]);

      expect(mockSocket.presenceSubscribe).toHaveBeenCalledTimes(2);
      expect(mockSocket.presenceSubscribe).toHaveBeenCalledWith("999@lid");
      expect(mockSocket.presenceSubscribe).toHaveBeenCalledWith(
        "user2@s.whatsapp.net",
      );
      expect(result.subscribed).toEqual(["999@lid", "user2@s.whatsapp.net"]);
    });

    it("subscribes again on repeated calls (no cache)", async () => {
      await connection.connect();
      mockSocket.presenceSubscribe.mockClear();

      await connection.presenceSubscribe(["user1@s.whatsapp.net"]);
      mockSocket.presenceSubscribe.mockClear();

      const result = await connection.presenceSubscribe([
        "user1@s.whatsapp.net",
      ]);

      expect(mockSocket.presenceSubscribe).toHaveBeenCalledTimes(1);
      expect(result.subscribed).toEqual(["user1@s.whatsapp.net"]);
    });
  });

  describe("autoSubscribePresence", () => {
    it("auto-subscribes on sendMessage when enabled", async () => {
      const conn = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        autoPresenceSubscribe: true,
      });
      await conn.connect();
      mockSocket.presenceSubscribe.mockClear();

      await conn.sendMessage("user@s.whatsapp.net", { text: "hi" });

      // Give the fire-and-forget promise time to resolve
      await new Promise((r) => setTimeout(r, 10));
      expect(mockSocket.presenceSubscribe).toHaveBeenCalledWith(
        "user@s.whatsapp.net",
      );
    });

    it("does NOT auto-subscribe when disabled (default)", async () => {
      await connection.connect();
      mockSocket.presenceSubscribe.mockClear();

      await connection.sendMessage("user@s.whatsapp.net", { text: "hi" });

      await new Promise((r) => setTimeout(r, 10));
      expect(mockSocket.presenceSubscribe).not.toHaveBeenCalled();
    });

    it("auto-subscribes on sendPresenceUpdate with composing/recording/paused", async () => {
      const conn = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        autoPresenceSubscribe: true,
      });
      await conn.connect();
      mockSocket.presenceSubscribe.mockClear();

      await conn.sendPresenceUpdate("composing", "user@s.whatsapp.net");

      await new Promise((r) => setTimeout(r, 10));
      expect(mockSocket.presenceSubscribe).toHaveBeenCalledWith(
        "user@s.whatsapp.net",
      );
    });

    it("does NOT auto-subscribe on sendPresenceUpdate with available/unavailable", async () => {
      const conn = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        autoPresenceSubscribe: true,
      });
      await conn.connect();
      mockSocket.presenceSubscribe.mockClear();

      await conn.sendPresenceUpdate("available");

      await new Promise((r) => setTimeout(r, 10));
      expect(mockSocket.presenceSubscribe).not.toHaveBeenCalled();
    });

    it("auto-subscribes on incoming messages (type: notify)", async () => {
      const conn = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        autoPresenceSubscribe: true,
      });
      await conn.connect();
      mockSocket.presenceSubscribe.mockClear();

      const handler = mockEventHandlers.get("messages.upsert")!;
      await handler({
        type: "notify",
        messages: [
          {
            key: { remoteJid: "sender@s.whatsapp.net", id: "msg-1" },
            message: { conversation: "hello" },
          },
        ],
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(mockSocket.presenceSubscribe).toHaveBeenCalledWith(
        "sender@s.whatsapp.net",
      );
    });

    it("does NOT auto-subscribe on history sync messages", async () => {
      const conn = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        autoPresenceSubscribe: true,
      });
      await conn.connect();
      mockSocket.presenceSubscribe.mockClear();

      const handler = mockEventHandlers.get("messages.upsert")!;
      await handler({
        type: "append",
        messages: [
          {
            key: { remoteJid: "sender@s.whatsapp.net", id: "msg-1" },
            message: { conversation: "hello" },
          },
        ],
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(mockSocket.presenceSubscribe).not.toHaveBeenCalled();
    });

    it("skips group JIDs in auto-subscribe", async () => {
      const conn = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        autoPresenceSubscribe: true,
      });
      await conn.connect();
      mockSocket.presenceSubscribe.mockClear();

      await conn.sendMessage("group@g.us", { text: "hi" });

      await new Promise((r) => setTimeout(r, 10));
      expect(mockSocket.presenceSubscribe).not.toHaveBeenCalled();
    });

    it("re-subscribes on repeated auto-subscribe calls (no cache)", async () => {
      const conn = new BaileysConnection("+5511999999999", {
        ...defaultOptions,
        autoPresenceSubscribe: true,
      });
      await conn.connect();
      mockSocket.presenceSubscribe.mockClear();

      await conn.sendMessage("user@s.whatsapp.net", { text: "hi" });
      await new Promise((r) => setTimeout(r, 10));
      expect(mockSocket.presenceSubscribe).toHaveBeenCalledTimes(1);

      mockSocket.presenceSubscribe.mockClear();
      await conn.sendMessage("user@s.whatsapp.net", { text: "hi again" });
      await new Promise((r) => setTimeout(r, 10));
      expect(mockSocket.presenceSubscribe).toHaveBeenCalledTimes(1);
    });
  });

  describe("LID resolution in presence events", () => {
    beforeEach(async () => {
      await connection.connect();
    });

    it("adds jidAlt when LID is resolved by Baileys signalRepository", async () => {
      mockSocket.signalRepository.lidMapping.getPNForLID.mockResolvedValueOnce(
        "553499503261@s.whatsapp.net",
      );

      const presenceHandler = mockEventHandlers.get("presence.update")!;
      await presenceHandler({
        id: "167392323834034@lid",
        presences: {
          "167392323834034@lid": { lastKnownPresence: "composing" },
        },
      });

      expect(
        mockSocket.signalRepository.lidMapping.getPNForLID,
      ).toHaveBeenCalledWith("167392323834034@lid");
      const presenceCall = fetchCalls.find((c) => {
        const body = JSON.parse(c.body);
        return body.event === "presence.update";
      });
      expect(presenceCall).toBeDefined();
      const body = JSON.parse(presenceCall!.body);
      expect(body.data.jidAlt).toBe("553499503261@s.whatsapp.net");
    });

    it("does not add jidAlt when presence id is not a LID", async () => {
      const presenceHandler = mockEventHandlers.get("presence.update")!;
      await presenceHandler({
        id: "553499503261@s.whatsapp.net",
        presences: {
          "553499503261@s.whatsapp.net": { lastKnownPresence: "available" },
        },
      });

      expect(
        mockSocket.signalRepository.lidMapping.getPNForLID,
      ).not.toHaveBeenCalled();
      const presenceCall = fetchCalls.find((c) => {
        const body = JSON.parse(c.body);
        return body.event === "presence.update";
      });
      const body = JSON.parse(presenceCall!.body);
      expect(body.data.jidAlt).toBeUndefined();
    });

    it("does not add jidAlt when LID has no known mapping", async () => {
      mockSocket.signalRepository.lidMapping.getPNForLID.mockResolvedValueOnce(
        null,
      );

      const presenceHandler = mockEventHandlers.get("presence.update")!;
      await presenceHandler({
        id: "999999999@lid",
        presences: {
          "999999999@lid": { lastKnownPresence: "composing" },
        },
      });

      const presenceCall = fetchCalls.find((c) => {
        const body = JSON.parse(c.body);
        return body.event === "presence.update";
      });
      const body = JSON.parse(presenceCall!.body);
      expect(body.data.jidAlt).toBeUndefined();
    });

    it("still forwards presence event if LID resolution fails", async () => {
      mockSocket.signalRepository.lidMapping.getPNForLID.mockRejectedValueOnce(
        new Error("resolution failed"),
      );

      const presenceHandler = mockEventHandlers.get("presence.update")!;
      await presenceHandler({
        id: "167392323834034@lid",
        presences: {
          "167392323834034@lid": { lastKnownPresence: "composing" },
        },
      });

      const presenceCall = fetchCalls.find((c) => {
        const body = JSON.parse(c.body);
        return body.event === "presence.update";
      });
      expect(presenceCall).toBeDefined();
      const body = JSON.parse(presenceCall!.body);
      expect(body.data.jidAlt).toBeUndefined();
      expect(body.data.id).toBe("167392323834034@lid");
    });
  });

  describe("Webhook retry logic", () => {
    // sendToWebhook is fire-and-forget from event handlers, so we need
    // to flush microtasks to let the retry loop settle.
    const flushAsync = async () => {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 0));
      }
    };

    it("retries on fetch failure", async () => {
      config.webhook.retryPolicy.maxRetries = 2;

      let callCount = 0;
      globalThis.fetch = mock(async () => {
        callCount++;
        if (callCount <= 2) {
          return new Response("error", { status: 500 });
        }
        return new Response("ok", { status: 200 });
      }) as any;

      await connection.connect();
      const handler = mockEventHandlers.get("messages.update")!;
      await handler([{ key: { id: "msg-1" }, update: {} }]);
      await flushAsync();

      expect(callCount).toBe(3); // initial + 2 retries
      config.webhook.retryPolicy.maxRetries = 0;
    });

    it("stops retrying after maxRetries", async () => {
      config.webhook.retryPolicy.maxRetries = 1;

      let callCount = 0;
      globalThis.fetch = mock(async () => {
        callCount++;
        return new Response("error", { status: 500 });
      }) as any;

      await connection.connect();
      const handler = mockEventHandlers.get("messages.update")!;
      await handler([{ key: { id: "msg-1" }, update: {} }]);
      await flushAsync();

      expect(callCount).toBe(2); // initial + 1 retry
      config.webhook.retryPolicy.maxRetries = 0;
    });

    it("handles fetch throwing an error", async () => {
      config.webhook.retryPolicy.maxRetries = 0;

      globalThis.fetch = mock(async () => {
        throw new Error("network failure");
      }) as any;

      await connection.connect();
      const handler = mockEventHandlers.get("messages.update")!;
      // Should not throw
      await handler([{ key: { id: "msg-1" }, update: {} }]);
      await flushAsync();
    });
  });

  describe("messaging-history.set", () => {
    function historyMessage(id: string, thumbnailBytes = 0) {
      const message: Record<string, unknown> = thumbnailBytes
        ? {
            imageMessage: {
              caption: `photo ${id}`,
              jpegThumbnail: new Uint8Array(thumbnailBytes).fill(255),
            },
          }
        : { conversation: `text ${id}` };

      return {
        key: { id, remoteJid: "5511888@s.whatsapp.net", fromMe: false },
        messageTimestamp: 1_700_000_000,
        message,
      };
    }

    function historyPayloads() {
      return fetchCalls
        .map((call) => JSON.parse(call.body))
        .filter((payload) => payload.event === "messaging-history.set")
        .map((payload) => payload.data);
    }

    // The lib's default drops FULL, which is the dump `syncFullHistory` asks the
    // phone for: without this override the option buys a bootstrap and an
    // offline replay, and the deep archive is discarded before it is decoded.
    describe("which dumps the lib is allowed to decode", () => {
      async function gate(syncFullHistory: boolean) {
        const conn = new BaileysConnection("+5511999999999", {
          ...defaultOptions,
          syncFullHistory,
        });
        await conn.connect();
        const makeSocket = ((await import("@whiskeysockets/baileys")) as any)
          .default as ReturnType<typeof mock>;
        const [socketOptions] = makeSocket.mock.calls.at(-1) as [
          {
            shouldSyncHistoryMessage: (msg: { syncType: number }) => boolean;
          },
        ];
        return socketOptions.shouldSyncHistoryMessage;
      }

      it("accepts the full archive when the inbox asked for it", async () => {
        const shouldSync = await gate(true);

        expect(shouldSync({ syncType: 2 })).toBe(true);
      });

      it("refuses it when the inbox did not", async () => {
        const shouldSync = await gate(false);

        expect(shouldSync({ syncType: 2 })).toBe(false);
      });

      // The offline replay is how a disconnect is recovered, so it is never
      // gated on a setting about the archive.
      it("takes the offline replay either way", async () => {
        expect((await gate(false))({ syncType: 3 })).toBe(true);
        expect((await gate(true))({ syncType: 3 })).toBe(true);
      });
    });

    it("forwards the dump even when syncFullHistory is off, since that is the offline replay", async () => {
      await connection.connect();
      const handler = mockEventHandlers.get("messaging-history.set")!;

      await handler({
        chats: [],
        contacts: [],
        messages: [historyMessage("A")],
        syncType: 3,
        isLatest: true,
      });

      const payloads = historyPayloads();
      expect(payloads).toHaveLength(1);
      expect(payloads[0].syncType).toBe(3);
      expect(payloads[0].isLatest).toBe(true);
      expect(payloads[0].chunkIndex).toBe(0);
      expect(payloads[0].messages).toHaveLength(1);
    });

    it("sends nothing for an empty dump", async () => {
      await connection.connect();
      const handler = mockEventHandlers.get("messaging-history.set")!;

      await handler({ chats: [], contacts: [], messages: [] });

      expect(historyPayloads()).toHaveLength(0);
    });

    // The only way WhatsApp ever says a chat is finished, and it says it on the
    // answer to an on-demand request and nowhere else. Discarding it left the
    // caller unable to tell "nothing older exists" from "the request went
    // nowhere", which is what a misaddressed request also looks like.
    describe("the chat-is-finished flag", () => {
      it("carries the flagged chats on the first frame", async () => {
        await connection.connect();
        const handler = mockEventHandlers.get("messaging-history.set")!;

        await handler({
          chats: [{ id: "5511888@lid", endOfHistoryTransferType: 1 }],
          contacts: [],
          messages: [historyMessage("ID-1")],
          syncType: 6,
        });

        expect(historyPayloads()[0].exhausted).toEqual(["5511888@lid"]);
      });

      it("sends the flag even when the answer carries no message", async () => {
        await connection.connect();
        const handler = mockEventHandlers.get("messaging-history.set")!;

        await handler({
          chats: [{ id: "5511888@lid", endOfHistoryTransferType: 1 }],
          contacts: [],
          messages: [],
          syncType: 6,
        });

        const payloads = historyPayloads();
        expect(payloads).toHaveLength(1);
        expect(payloads[0].messages).toEqual([]);
        expect(payloads[0].exhausted).toEqual(["5511888@lid"]);
      });

      // An answer that still has history behind it ships no chat record at all,
      // so silence on this field is "no news", not "there is more".
      it("says nothing when no chat was flagged", async () => {
        await connection.connect();
        const handler = mockEventHandlers.get("messaging-history.set")!;

        await handler({
          chats: [{ id: "5511888@lid" }],
          contacts: [],
          messages: [historyMessage("ID-1")],
          syncType: 6,
        });

        expect(historyPayloads()[0].exhausted).toBeUndefined();
      });
    });

    it("splits a large dump into frames under the budget, numbered in order", async () => {
      const previousBudget = config.webhook.historyFrameMaxBytes;
      config.webhook.historyFrameMaxBytes = 2_048;

      try {
        await connection.connect();
        const handler = mockEventHandlers.get("messaging-history.set")!;
        const messages = Array.from({ length: 60 }, (_, i) =>
          historyMessage(`ID-${i}`),
        );

        await handler({ chats: [], contacts: [], messages, syncType: 0 });

        const payloads = historyPayloads();
        expect(payloads.length).toBeGreaterThan(1);
        expect(payloads.map((payload) => payload.chunkIndex)).toEqual(
          payloads.map((_, index) => index),
        );
        for (const payload of payloads) {
          expect(payload.syncType).toBe(0);
        }

        const ids = payloads.flatMap((payload) =>
          payload.messages.map(
            (message: { key: { id: string } }) => message.key.id,
          ),
        );
        expect(ids).toEqual(messages.map((message) => message.key.id));
      } finally {
        config.webhook.historyFrameMaxBytes = previousBudget;
      }
    });

    it("strips thumbnails, so the body never carries the bytes nothing reads", async () => {
      await connection.connect();
      const handler = mockEventHandlers.get("messaging-history.set")!;

      await handler({
        chats: [],
        contacts: [],
        messages: [historyMessage("A", 4_096)],
      });

      const [payload] = historyPayloads();
      expect(payload.messages[0].message.imageMessage.caption).toBe("photo A");
      expect(
        payload.messages[0].message.imageMessage.jpegThumbnail,
      ).toBeUndefined();
    });

    // A dump's keys are raw protobuf: the addressing fields a live key carries
    // do not exist there, so a LID-addressed chat arrives with the phone number
    // nowhere in it and a client files the LID as one.
    describe("the addressing a dump strips", () => {
      const LID = "235085806727321@lid";
      const PN = "5511999999999@s.whatsapp.net";

      function lidMessage(id: string) {
        return {
          key: { id, remoteJid: LID, fromMe: false },
          messageTimestamp: 1_700_000_000,
          message: { conversation: `text ${id}` },
        };
      }

      it("takes the mapping the event itself carries, without asking the store", async () => {
        await connection.connect();
        const handler = mockEventHandlers.get("messaging-history.set")!;

        await handler({
          chats: [],
          contacts: [],
          messages: [lidMessage("A")],
          lidPnMappings: [{ lid: LID, pn: PN }],
          syncType: 2,
        });

        const [{ key }] = historyPayloads()[0].messages;
        expect(key.remoteJidAlt).toBe(PN);
        expect(key.addressingMode).toBe("lid");
        expect(
          mockSocket.signalRepository.lidMapping.getPNsForLIDs,
        ).not.toHaveBeenCalled();
      });

      // The shape a real history notification arrives in: it is processed inside
      // `ev.buffer()`, and the buffer rebuilds the event field by field from what it
      // accumulated, keeping the chat records and dropping the derived mapping list.
      it("takes the mapping off the chat records when the buffer dropped the list", async () => {
        await connection.connect();
        const handler = mockEventHandlers.get("messaging-history.set")!;

        await handler({
          chats: [{ id: LID, pnJid: PN }],
          contacts: [],
          messages: [lidMessage("A")],
          syncType: 2,
        });

        const [{ key }] = historyPayloads()[0].messages;
        expect(key.remoteJidAlt).toBe(PN);
        expect(
          mockSocket.signalRepository.lidMapping.getPNsForLIDs,
        ).not.toHaveBeenCalled();
      });

      it("asks the store for what the event did not name", async () => {
        await connection.connect();
        mockSocket.signalRepository.lidMapping.getPNsForLIDs.mockResolvedValueOnce(
          [{ lid: LID, pn: PN }],
        );
        const handler = mockEventHandlers.get("messaging-history.set")!;

        await handler({
          chats: [],
          contacts: [],
          messages: [lidMessage("A"), lidMessage("B")],
          syncType: 2,
        });

        const [{ key }] = historyPayloads()[0].messages;
        expect(key.remoteJidAlt).toBe(PN);
        // One batched read for the whole dump, not one per message.
        expect(
          mockSocket.signalRepository.lidMapping.getPNsForLIDs,
        ).toHaveBeenCalledTimes(1);
        expect(
          mockSocket.signalRepository.lidMapping.getPNsForLIDs,
        ).toHaveBeenCalledWith([LID]);
      });

      it("never asks about a dump that has no LID in it", async () => {
        await connection.connect();
        const handler = mockEventHandlers.get("messaging-history.set")!;

        await handler({
          chats: [],
          contacts: [],
          messages: [historyMessage("A")],
          syncType: 2,
        });

        expect(
          mockSocket.signalRepository.lidMapping.getPNsForLIDs,
        ).not.toHaveBeenCalled();
      });

      // The dump is the point. A store that cannot answer costs the phone
      // numbers, never the messages -- and the keys still say they are LIDs,
      // which is what stops the client filing one as a number.
      it("still delivers the dump when the store throws", async () => {
        await connection.connect();
        mockSocket.signalRepository.lidMapping.getPNsForLIDs.mockRejectedValueOnce(
          new Error("store down"),
        );
        const handler = mockEventHandlers.get("messaging-history.set")!;

        await handler({
          chats: [],
          contacts: [],
          messages: [lidMessage("A")],
          syncType: 2,
        });

        const [{ key }] = historyPayloads()[0].messages;
        expect(key.remoteJidAlt).toBeUndefined();
        expect(key.addressingMode).toBe("lid");
        expect(key.id).toBe("A");
      });
    });

    it("drops the chat and contact lists, which nothing reads and which double the dump", async () => {
      await connection.connect();
      const handler = mockEventHandlers.get("messaging-history.set")!;

      await handler({
        chats: [{ id: "5511888@s.whatsapp.net" }],
        contacts: [{ id: "5511888@s.whatsapp.net", name: "June" }],
        messages: [historyMessage("A")],
      });

      const [payload] = historyPayloads();
      expect(payload.chats).toBeUndefined();
      expect(payload.contacts).toBeUndefined();
    });
  });
});
