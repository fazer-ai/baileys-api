import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  setSystemTime,
} from "bun:test";

// Track fetch calls for webhook tests
const fetchCalls: Array<{ url: string; body: string }> = [];
const originalFetch = globalThis.fetch;

import * as baileysModule from "@whiskeysockets/baileys";
import config from "@/config";
import { asyncSleep } from "@/helpers/asyncSleep";
import redis from "@/lib/redis";
import { BaileysConnection, BaileysNotConnectedError } from "./connection";

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
});
