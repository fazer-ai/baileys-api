import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type mock,
  spyOn,
} from "bun:test";
import Elysia from "elysia";
import baileys from "@/baileys";
import { BaileysSendStalledError } from "@/baileys/connection";
import coordinator from "@/cluster";
import { BaileysConnectionOwnedElsewhereError } from "@/cluster/coordinator";
import config from "@/config";
import { OperationTimeoutError } from "@/helpers/withTimeout";
import redis from "@/lib/redis";
import connectionsController from "./index";

// Elysia merges the controller-level `detail` into each route by mutating a shallow copy, so a
// shared `responses` object would collect every route's responses and hand them to all the others.
// The documented contract would then be wrong for nearly every endpoint.
describe("connectionsController route documentation", () => {
  const responsesFor = (method: string, path: string) =>
    connectionsController.routes.find(
      (route) => route.method === method && route.path === path,
    )?.hooks?.detail?.responses as Record<string, { description?: string }>;

  it("keeps each route's own response descriptions", () => {
    const sendMessage = responsesFor(
      "POST",
      "/connections/:phoneNumber/send-message",
    );
    const editMessage = responsesFor(
      "PATCH",
      "/connections/:phoneNumber/messages",
    );

    // Substring, not equality: the guard is against the cluster-ownership 409
    // description leaking onto this route, which this still catches — without
    // breaking every time the idempotency wording is refined.
    expect(sendMessage[409]?.description).toContain(
      "Message is already being processed",
    );
    expect(sendMessage[500]?.description).toBe("Message not sent");
    expect(editMessage[500]?.description).toBe("Message not edited");
  });

  it("still documents the shared responses on every route", () => {
    for (const route of connectionsController.routes) {
      const responses = route.hooks?.detail?.responses as
        | Record<string, unknown>
        | undefined;
      expect(Object.keys(responses ?? {})).toEqual(
        expect.arrayContaining(["403", "421"]),
      );
    }
  });
});

// The send-message route maps a missing local socket to 404 (instead of a
// generic 500) so callers can tell "phone not connected" from a real failure.
describe("connectionsController send-message", () => {
  let prevEnv: typeof config.env;
  let prevRole: typeof config.cluster.role;

  beforeEach(() => {
    prevEnv = config.env;
    prevRole = config.cluster.role;
    // Dev mode bypasses the auth middleware, and standalone role skips the
    // worker 421 re-routing in onBeforeHandle.
    config.env = "development";
    config.cluster.role = "standalone";
  });

  afterEach(() => {
    config.env = prevEnv;
    config.cluster.role = prevRole;
  });

  const sendMessageRequest = (phone: string, extraBody: object = {}) =>
    new Request(`http://localhost/connections/${phone}/send-message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jid: "551101234567@s.whatsapp.net",
        messageContent: { text: "hello" },
        ...extraBody,
      }),
    });

  it("returns 404 when the phone has no live connection", async () => {
    const app = new Elysia().use(connectionsController);

    // No connection registered for this phone, so the handler's getConnection
    // throws BaileysNotConnectedError on the real code path.
    const res = await app.handle(sendMessageRequest("+551234567890"));

    expect(res.status).toBe(404);
  });

  // The caller reserves the WhatsApp message id before the send so it can match
  // the `messages.upsert` echo of its own message even if this response is lost.
  it("forwards the reserved messageId to the send", async () => {
    const spy = spyOn(baileys, "sendMessage").mockResolvedValue({
      key: { id: "3EB0RESERVED" },
      messageTimestamp: 1,
    } as any);

    try {
      const app = new Elysia().use(connectionsController);
      const res = await app.handle(
        sendMessageRequest("+551234567890", { messageId: "3EB0RESERVED" }),
      );

      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith(
        "+551234567890",
        expect.objectContaining({ messageId: "3EB0RESERVED" }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  // An empty string would pass through as falsy and let Baileys generate an id
  // the caller never learns about, so it is rejected instead.
  it("rejects an empty messageId", async () => {
    const app = new Elysia().use(connectionsController);
    const res = await app.handle(
      sendMessageRequest("+551234567890", { messageId: "" }),
    );

    expect(res.status).toBe(422);
  });

  it("does not mask a generic send failure as 404", async () => {
    const spy = spyOn(baileys, "sendMessage").mockImplementation(async () => {
      throw new Error("unexpected boom");
    });

    try {
      const app = new Elysia().use(connectionsController);
      const res = await app.handle(sendMessageRequest("+551234567890"));

      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
  });

  // 504 and 503 say different things on purpose: 504 is "this attempt expired,
  // outcome unknown, a careful retry is fine"; 503 is "this connection is known
  // not to be sending, stop burning workers on it".
  it("answers 504 when the send times out", async () => {
    const spy = spyOn(baileys, "sendMessage").mockImplementation(async () => {
      throw new OperationTimeoutError("sendMessage", 45_000);
    });

    try {
      const app = new Elysia().use(connectionsController);
      const res = await app.handle(
        sendMessageRequest("+551234567890", { messageId: "3EB0RESERVED" }),
      );

      expect(res.status).toBe(504);
      expect(res.headers.get("retry-after")).toBe("60");
    } finally {
      spy.mockRestore();
    }
  });

  // delete and edit relay through the same socket.sendMessage, so they take the
  // same keystore mutex and can fail the same two ways. Answering 500 would
  // present documented, expected behaviour as an internal error.
  it.each([
    ["deleteMessage", "DELETE"],
    ["editMessage", "PATCH"],
  ])("maps %s timeouts to 504 like send-message", async (method, verb) => {
    const spy = spyOn(
      baileys,
      method as "deleteMessage" | "editMessage",
    ).mockImplementation(async () => {
      throw new OperationTimeoutError(method, 45_000);
    });

    try {
      const app = new Elysia().use(connectionsController);
      const res = await app.handle(
        new Request("http://localhost/connections/%2B551234567890/messages", {
          method: verb,
          headers: {
            "content-type": "application/json",
            "x-api-key": "test-api-key",
          },
          body: JSON.stringify({
            jid: "551101234567@s.whatsapp.net",
            key: { id: "msg-id" },
            ...(verb === "PATCH" ? { messageContent: { text: "hi" } } : {}),
          }),
        }),
      );

      expect(res.status).toBe(504);
      expect(res.headers.get("retry-after")).toBe("60");
    } finally {
      spy.mockRestore();
    }
  });

  it("answers 503 when the connection is already known to be stalled", async () => {
    const spy = spyOn(baileys, "sendMessage").mockImplementation(async () => {
      throw new BaileysSendStalledError();
    });

    try {
      const app = new Elysia().use(connectionsController);
      const res = await app.handle(sendMessageRequest("+551234567890"));

      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("60");
      // An ordinary outage, a draining proxy and a wedged socket all answer 503,
      // and only this one means "the connection is up, do not mark it down". A
      // caller that reads the status alone skips a reconnect it needed.
      expect(res.headers.get("x-baileys-send-state")).toBe("stalled");
    } finally {
      spy.mockRestore();
    }
  });

  // The wedge reported one layer down, by the patched keystore transaction. Left
  // unmapped it leaves as a generic 500, which tells the caller nothing and gets
  // the channel marked down on the Chatwoot side. It is retry-safe unconditionally,
  // unlike the 504: a waiter that gave up on the mutex never entered the
  // transaction, so no node reached the wire and the message was not sent.
  it("answers 503 when a keystore transaction gives up on its mutex", async () => {
    const spy = spyOn(baileys, "sendMessage").mockImplementation(async () => {
      throw Object.assign(new Error("keystore transaction timed out"), {
        data: { key: "me@s.whatsapp.net", code: "E_TX_MUTEX_TIMEOUT" },
      });
    });

    try {
      const app = new Elysia().use(connectionsController);
      // No reserved id, which is what makes the 504 branch above answer
      // "unprotected". This branch must not care: nothing was sent.
      const res = await app.handle(sendMessageRequest("+551234567890"));

      expect(res.status).toBe(503);
      expect(res.headers.get("x-baileys-send-state")).toBe("stalled");
      expect(res.headers.get("retry-after")).toBe("60");
      expect(await res.text()).toContain("was not sent");
    } finally {
      spy.mockRestore();
    }
  });

  // With neither a chatwootMessageId nor a messageId there is no key, so
  // withIdempotency takes its no-key path and never records anything: nothing
  // stands between a retry and a second WhatsApp message. The response must not
  // ask for that retry.
  it("does not invite a retry when a timed-out send reserved no id at all", async () => {
    const spy = spyOn(baileys, "sendMessage").mockImplementation(async () => {
      throw new OperationTimeoutError("sendMessage", 45_000);
    });

    try {
      const app = new Elysia().use(connectionsController);
      const res = await app.handle(sendMessageRequest("+551234567890"));

      expect(res.status).toBe(504);
      expect(res.headers.get("retry-after")).toBeNull();
      expect(res.headers.get("x-baileys-idempotency-state")).toBe(
        "unprotected",
      );
    } finally {
      spy.mockRestore();
    }
  });

  // The idempotency key alone is protection enough: the retry meets the
  // indeterminate marker and gets a 409 instead of sending again.
  it("still invites a retry when only an idempotency key was supplied", async () => {
    const stringData = (redis as any).__stringData as Map<string, string>;
    stringData.clear();
    const spy = spyOn(baileys, "sendMessage").mockImplementation(async () => {
      throw new OperationTimeoutError("sendMessage", 45_000);
    });

    try {
      const app = new Elysia().use(connectionsController);
      const res = await app.handle(
        sendMessageRequest("+551234567890", { chatwootMessageId: "42" }),
      );

      expect(res.status).toBe(504);
      expect(res.headers.get("retry-after")).toBe("60");
    } finally {
      spy.mockRestore();
      stringData.clear();
    }
  });

  // Holding a key is not the same as being protected by one. withIdempotency
  // fails open on purpose -- acquireLock returns success when it cannot write and
  // markIndeterminate only warns -- so a Redis outage runs the send unlocked and
  // leaves nothing behind. `retry-after` is an instruction, and issuing one here
  // tells the caller to do the one thing that duplicates.
  it("does not invite a retry when the marker could not be written", async () => {
    const stringData = (redis as any).__stringData as Map<string, string>;
    stringData.clear();
    const spy = spyOn(baileys, "sendMessage").mockImplementation(async () => {
      throw new OperationTimeoutError("sendMessage", 45_000);
    });
    // mockImplementationOnce on the existing mocks, never spyOn: these are
    // already mocks here, and spying over one leaks past mockRestore into every
    // later spec file. Both writes have to be reached -- the lock acquire (SET,
    // which fails open) and the marker (a compare-and-set EVAL).
    const setMock = redis.set as unknown as ReturnType<typeof mock>;
    const evalMock = redis.eval as unknown as ReturnType<typeof mock>;
    setMock.mockClear();
    evalMock.mockClear();
    const down = async () => {
      throw new Error("redis down");
    };
    setMock.mockImplementationOnce(down);
    evalMock.mockImplementationOnce(down);

    try {
      const app = new Elysia().use(connectionsController);
      const res = await app.handle(
        sendMessageRequest("+551234567890", { chatwootMessageId: "42" }),
      );

      expect(res.status).toBe(504);
      expect(res.headers.get("retry-after")).toBeNull();
      expect(res.headers.get("x-baileys-idempotency-state")).toBe(
        "unprotected",
      );
      // Nothing was recorded, which is exactly why the retry is not safe.
      expect(
        stringData.has(
          "@baileys-api:idempotency:send-message:+551234567890:42",
        ),
      ).toBe(false);
      // Both writes were actually attempted, or the stubs above proved nothing.
      expect(setMock.mock.calls.length).toBe(1);
      expect(evalMock.mock.calls.length).toBe(1);
    } finally {
      spy.mockRestore();
      stringData.clear();
    }
  });

  // The marker says "outcome unknown". A mutex-acquire timeout arriving minutes
  // later makes it known: that waiter never entered the transaction, so it read
  // nothing, wrote nothing and relayed nothing. Leaving the marker up then 409s
  // the operator's resend of this same message for 24h, when a resend is now
  // exactly the right thing.
  it("retracts the indeterminate marker once the send is proved not to have happened", async () => {
    const stringData = (redis as any).__stringData as Map<string, string>;
    stringData.clear();
    let lateFailure: (() => void) | undefined;
    const spy = spyOn(baileys, "sendMessage").mockImplementation(
      async (
        _phone: string,
        args: { onLateDefinitiveFailure?: () => void },
      ) => {
        lateFailure = args.onLateDefinitiveFailure;
        throw new OperationTimeoutError("sendMessage", 45_000);
      },
    );

    try {
      const app = new Elysia().use(connectionsController);
      await app.handle(
        sendMessageRequest("+551234567890", { chatwootMessageId: "42" }),
      );

      const key = "@baileys-api:idempotency:send-message:+551234567890:42";
      expect(stringData.get(key)).toStartWith("indeterminate:");

      // The parked send finally rejects, with the one error that proves it never
      // reached WhatsApp.
      expect(lateFailure).toBeDefined();
      lateFailure?.();
      await new Promise((r) => setTimeout(r, 5));
      expect(stringData.has(key)).toBe(false);

      // And the resend now goes through instead of meeting a 409.
      spy.mockImplementation(async () => ({
        key: { id: "3EB0AGAIN" },
        messageTimestamp: 1,
      }));
      const res = await app.handle(
        sendMessageRequest("+551234567890", { chatwootMessageId: "42" }),
      );
      expect(res.status).toBe(200);
    } finally {
      spy.mockRestore();
      stringData.clear();
    }
  });

  // The two events race. markIndeterminate is a Redis round trip, and the parked
  // send can reject inside it -- so the "never sent" verdict can arrive while
  // there is still no marker to retract. Acting on it inline would leave the
  // marker that lands a moment later standing for 24h over an outcome that is no
  // longer unknown, 409ing the operator's resend of a message that never went.
  it("retracts a marker installed after the never-sent verdict arrived", async () => {
    const stringData = (redis as any).__stringData as Map<string, string>;
    stringData.clear();
    const spy = spyOn(baileys, "sendMessage").mockImplementation(
      async (
        _phone: string,
        args: { onLateDefinitiveFailure?: () => void },
      ) => {
        // The verdict beats the marker: it fires while withIdempotency is still
        // on its way to writing one.
        args.onLateDefinitiveFailure?.();
        throw new OperationTimeoutError("sendMessage", 45_000);
      },
    );

    try {
      const app = new Elysia().use(connectionsController);
      const res = await app.handle(
        sendMessageRequest("+551234567890", { chatwootMessageId: "42" }),
      );

      await new Promise((r) => setTimeout(r, 5));
      const key = "@baileys-api:idempotency:send-message:+551234567890:42";
      expect(stringData.has(key)).toBe(false);

      // And the answer says a retry is safe, because the send provably did not
      // happen.
      expect(res.status).toBe(504);
      expect(res.headers.get("retry-after")).toBe("60");

      // The resend goes through instead of meeting a 409.
      spy.mockImplementation(async () => ({
        key: { id: "3EB0AGAIN" },
        messageTimestamp: 1,
      }));
      const resend = await app.handle(
        sendMessageRequest("+551234567890", { chatwootMessageId: "42" }),
      );
      expect(resend.status).toBe(200);
    } finally {
      spy.mockRestore();
      stringData.clear();
    }
  });

  // With a reserved messageId the resend lands on the same WhatsApp key.id, so
  // WhatsApp dedupes it and releasing the lock is strictly safe.
  it("releases the idempotency lock on timeout when a messageId was reserved", async () => {
    const stringData = (redis as any).__stringData as Map<string, string>;
    stringData.clear();
    const spy = spyOn(baileys, "sendMessage").mockImplementation(async () => {
      throw new OperationTimeoutError("sendMessage", 45_000);
    });

    try {
      const app = new Elysia().use(connectionsController);
      await app.handle(
        sendMessageRequest("+551234567890", {
          chatwootMessageId: "42",
          messageId: "3EB0RESERVED",
        }),
      );

      const key = "@baileys-api:idempotency:send-message:+551234567890:42";
      expect(stringData.has(key)).toBe(false);
    } finally {
      spy.mockRestore();
      stringData.clear();
    }
  });

  // Without one, a retry would create a SECOND WhatsApp message, so the outcome
  // is recorded as unknown and the caller is told to reconcile.
  it("marks the outcome indeterminate on timeout when no messageId was reserved", async () => {
    const stringData = (redis as any).__stringData as Map<string, string>;
    stringData.clear();
    const spy = spyOn(baileys, "sendMessage").mockImplementation(async () => {
      throw new OperationTimeoutError("sendMessage", 45_000);
    });

    try {
      const app = new Elysia().use(connectionsController);
      await app.handle(
        sendMessageRequest("+551234567890", { chatwootMessageId: "42" }),
      );

      const key = "@baileys-api:idempotency:send-message:+551234567890:42";
      expect(stringData.get(key)).toStartWith("indeterminate:");

      // The follow-up retry gets a 409 that says which kind of conflict it is.
      const res = await app.handle(
        sendMessageRequest("+551234567890", { chatwootMessageId: "42" }),
      );
      expect(res.status).toBe(409);
      expect(res.headers.get("x-baileys-idempotency-state")).toBe(
        "indeterminate",
      );
      // No retry-after: nothing clears this marker on a timer. It outlives the
      // caller's retries by design, so a 60-second wait would promise a state
      // change that never comes and turn a message needing reconciliation into
      // a job that retries for a day.
      expect(res.headers.get("retry-after")).toBeNull();
      // The body reaches a person: Chatwoot stores it as the message's
      // external_error, and it is what an agent acts on. It must not name the
      // one procedure that duplicates: a resend under a new chatwootMessageId
      // asks a different question and sidesteps this marker entirely, while the
      // timed-out attempt reserved no WhatsApp id for anything to deduplicate
      // against.
      const body = await res.text();
      expect(body).toContain("Reconcile against the conversation");
      expect(body).not.toContain("chatwootMessageId");
    } finally {
      spy.mockRestore();
      stringData.clear();
    }
  });

  // A marker is only ever written for a send that had NO reserved id, so the
  // WhatsApp key that attempt used is unknown to us. A retry supplying a freshly
  // reserved id lands on a DIFFERENT key, which is a second message rather than a
  // deduplicated one — so the id that makes a FIRST send safe does not make this
  // retry safe, and the marker holds.
  it("refuses a resend with a reserved messageId past an indeterminate marker", async () => {
    const stringData = (redis as any).__stringData as Map<string, string>;
    stringData.clear();
    const spy = spyOn(baileys, "sendMessage").mockImplementation(async () => {
      throw new OperationTimeoutError("sendMessage", 45_000);
    });

    try {
      const app = new Elysia().use(connectionsController);
      await app.handle(
        sendMessageRequest("+551234567890", { chatwootMessageId: "42" }),
      );
      const key = "@baileys-api:idempotency:send-message:+551234567890:42";
      expect(stringData.get(key)).toStartWith("indeterminate:");

      spy.mockImplementation(async () => ({
        key: { id: "3EB0RESERVED" },
        messageTimestamp: 1,
      }));
      const res = await app.handle(
        sendMessageRequest("+551234567890", {
          chatwootMessageId: "42",
          messageId: "3EB0RESERVED",
        }),
      );

      expect(res.status).toBe(409);
      expect(res.headers.get("x-baileys-idempotency-state")).toBe(
        "indeterminate",
      );
    } finally {
      spy.mockRestore();
      stringData.clear();
    }
  });
});

// Read-only restriction diagnostics: fetch the 463 reach-out time-lock state
// and the new-chat message cap without sending a message.
describe("connectionsController restriction diagnostics", () => {
  let prevEnv: typeof config.env;
  let prevRole: typeof config.cluster.role;

  beforeEach(() => {
    prevEnv = config.env;
    prevRole = config.cluster.role;
    config.env = "development";
    config.cluster.role = "standalone";
  });

  afterEach(() => {
    config.env = prevEnv;
    config.cluster.role = prevRole;
  });

  const getRequest = (phone: string, path: string) =>
    new Request(`http://localhost/connections/${phone}/${path}`, {
      method: "GET",
    });

  describe("GET /:phoneNumber/reachout-timelock", () => {
    it("returns 200 with the reach-out time-lock state", async () => {
      const spy = spyOn(baileys, "getReachoutTimelock").mockResolvedValue({
        isActive: true,
        enforcementType: "BIZ_QUALITY",
      } as any);

      try {
        const app = new Elysia().use(connectionsController);
        const res = await app.handle(
          getRequest("+551234567890", "reachout-timelock"),
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as { data: { isActive: boolean } };
        expect(body.data.isActive).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it("returns 404 when the phone has no live connection", async () => {
      // No connection registered, so getConnection throws on the real path.
      const app = new Elysia().use(connectionsController);
      const res = await app.handle(
        getRequest("+551234567890", "reachout-timelock"),
      );

      expect(res.status).toBe(404);
    });
  });

  describe("GET /:phoneNumber/new-chat-cap", () => {
    it("returns 200 with the new-chat message cap", async () => {
      const spy = spyOn(baileys, "getNewChatMessageCap").mockResolvedValue({
        total_quota: 100,
        used_quota: 10,
        capping_status: "NONE",
      } as any);

      try {
        const app = new Elysia().use(connectionsController);
        const res = await app.handle(
          getRequest("+551234567890", "new-chat-cap"),
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as { data: { total_quota: number } };
        expect(body.data.total_quota).toBe(100);
      } finally {
        spy.mockRestore();
      }
    });

    it("returns 404 when the phone has no live connection", async () => {
      const app = new Elysia().use(connectionsController);
      const res = await app.handle(getRequest("+551234567890", "new-chat-cap"));

      expect(res.status).toBe(404);
    });
  });
});

describe("connectionsController import-session", () => {
  let prevEnv: typeof config.env;
  let prevRole: typeof config.cluster.role;

  beforeEach(() => {
    prevEnv = config.env;
    prevRole = config.cluster.role;
    config.env = "development";
    config.cluster.role = "standalone";
  });

  afterEach(() => {
    config.env = prevEnv;
    config.cluster.role = prevRole;
  });

  const b64 = (s: string) => Buffer.from(s).toString("base64");

  const validSession = () => ({
    noiseCandidates: [
      { private: b64("np0"), public: b64("nb0") },
      { private: b64("np1"), public: b64("nb1") },
    ],
    identityKey: { private: b64("ip"), public: b64("ib") },
    registrationId: 42,
    advSecretKey: b64("adv"),
    account: {
      details: b64("d"),
      accountSignatureKey: b64("ask"),
      accountSignature: b64("as"),
      deviceSignature: b64("ds"),
    },
    id: "551101234567:12@s.whatsapp.net",
    lid: "551101234567@s.whatsapp.net",
  });

  const validBody = () => ({
    session: validSession(),
    webhookUrl: "http://localhost:3026/whatsapp/+551234567890",
    webhookVerifyToken: "verify",
  });

  const importRequest = (phone: string, body: unknown) =>
    new Request(`http://localhost/connections/${phone}/import-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("maps the session and hands off to the coordinator (202)", async () => {
    const spy = spyOn(coordinator, "importSessionWithLease").mockResolvedValue(
      undefined,
    );
    try {
      const app = new Elysia().use(connectionsController);
      const res = await app.handle(importRequest("+551234567890", validBody()));

      expect(res.status).toBe(202);
      expect(spy).toHaveBeenCalledWith(
        "+551234567890",
        expect.objectContaining({ registered: true }),
        expect.arrayContaining([
          expect.objectContaining({ private: expect.any(String) }),
        ]),
        0,
        expect.objectContaining({
          webhookUrl: "http://localhost:3026/whatsapp/+551234567890",
          webhookVerifyToken: "verify",
        }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("returns 422 when the noise candidate index is out of range", async () => {
    const spy = spyOn(coordinator, "importSessionWithLease");
    try {
      const app = new Elysia().use(connectionsController);
      const res = await app.handle(
        importRequest("+551234567890", { ...validBody(), candidateIndex: 9 }),
      );

      expect(res.status).toBe(422);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("surfaces a live owner elsewhere as 409 with x-baileys-owner", async () => {
    const spy = spyOn(coordinator, "importSessionWithLease").mockImplementation(
      async () => {
        throw new BaileysConnectionOwnedElsewhereError("owner-2");
      },
    );
    try {
      const app = new Elysia().use(connectionsController);
      const res = await app.handle(importRequest("+551234567890", validBody()));

      expect(res.status).toBe(409);
      expect(res.headers.get("x-baileys-owner")).toBe("owner-2");
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects a body missing the webhook fields", async () => {
    const app = new Elysia().use(connectionsController);
    const res = await app.handle(
      importRequest("+551234567890", { session: validSession() }),
    );

    expect(res.status).toBe(422);
  });
});

describe("connectionsController restart", () => {
  let prevEnv: typeof config.env;
  let prevRole: typeof config.cluster.role;
  const stringData = (redis as any).__stringData as Map<string, string>;

  beforeEach(() => {
    prevEnv = config.env;
    prevRole = config.cluster.role;
    config.env = "development";
    config.cluster.role = "standalone";
    stringData.clear();
  });

  afterEach(() => {
    config.env = prevEnv;
    config.cluster.role = prevRole;
    stringData.clear();
  });

  const restartRequest = (phone: string) =>
    new Request(`http://localhost/connections/${phone}/restart`, {
      method: "POST",
    });

  it("answers 202 once the restart is accepted", async () => {
    const spy = spyOn(coordinator, "restartWithLease").mockResolvedValue(
      "restarted",
    );

    try {
      const app = new Elysia().use(connectionsController);
      const res = await app.handle(restartRequest("+551234567890"));

      expect(res.status).toBe(202);
      expect(spy).toHaveBeenCalledWith("+551234567890", undefined);
    } finally {
      spy.mockRestore();
    }
  });

  it("passes the caller's reason through to the coordinator", async () => {
    const spy = spyOn(coordinator, "restartWithLease").mockResolvedValue(
      "restarted",
    );

    try {
      const app = new Elysia().use(connectionsController);
      const res = await app.handle(
        new Request("http://localhost/connections/+551234567890/restart", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "send stall" }),
        }),
      );

      expect(res.status).toBe(202);
      expect(spy).toHaveBeenCalledWith("+551234567890", "send stall");
    } finally {
      spy.mockRestore();
    }
  });

  // A newer explicit operation ran first, which usually leaves a perfectly good
  // session behind. 404 would send the caller off to re-pair what somebody else
  // just rebuilt.
  it("answers 409 when another operation superseded the restart", async () => {
    const spy = spyOn(coordinator, "restartWithLease").mockResolvedValue(
      "superseded",
    );

    try {
      const app = new Elysia().use(connectionsController);
      const res = await app.handle(restartRequest("+551234567890"));

      expect(res.status).toBe(409);
    } finally {
      spy.mockRestore();
    }
  });

  it("answers 404 when there is no stored session to restart", async () => {
    const spy = spyOn(coordinator, "restartWithLease").mockResolvedValue(
      "not-found",
    );

    try {
      const app = new Elysia().use(connectionsController);
      const res = await app.handle(restartRequest("+551234567890"));

      expect(res.status).toBe(404);
    } finally {
      spy.mockRestore();
    }
  });

  it("answers 409 with the owner when a live peer owns the phone", async () => {
    const spy = spyOn(coordinator, "restartWithLease").mockImplementation(
      async () => {
        throw new BaileysConnectionOwnedElsewhereError("other-instance");
      },
    );

    try {
      const app = new Elysia().use(connectionsController);
      const res = await app.handle(restartRequest("+551234567890"));

      expect(res.status).toBe(409);
      expect(res.headers.get("x-baileys-owner")).toBe("other-instance");
    } finally {
      spy.mockRestore();
    }
  });

  // The highest-value test here. Without /restart in the takeover allowlist,
  // onBeforeHandle answers 421 and sends the caller back to the very instance
  // whose socket is wedged — the one answer guaranteed not to help. Ownership
  // must be resolved by the coordinator (409), not by the misdirect check.
  it("is not answered with 421, even when another live instance holds the lease", async () => {
    config.cluster.role = "worker";
    stringData.set(
      "@baileys-api:cluster:lease:+551234567890",
      JSON.stringify({ owner: "other-instance", epoch: 7 }),
    );
    stringData.set("@baileys-api:cluster:instance:other-instance", "{}");

    const spy = spyOn(coordinator, "restartWithLease").mockImplementation(
      async () => {
        throw new BaileysConnectionOwnedElsewhereError("other-instance");
      },
    );

    try {
      const app = new Elysia().use(connectionsController);
      const res = await app.handle(restartRequest("+551234567890"));

      expect(res.status).not.toBe(421);
      expect(res.status).toBe(409);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // The control: a non-takeover route in the same situation DOES get the 421,
  // which is what proves the exemption above is scoped and not a blanket hole.
  it("still answers 421 for a non-takeover route in the same situation", async () => {
    config.cluster.role = "worker";
    stringData.set(
      "@baileys-api:cluster:lease:+551234567890",
      JSON.stringify({ owner: "other-instance", epoch: 7 }),
    );
    stringData.set("@baileys-api:cluster:instance:other-instance", "{}");

    const app = new Elysia().use(connectionsController);
    const res = await app.handle(
      new Request("http://localhost/connections/+551234567890/health", {
        method: "GET",
      }),
    );

    expect(res.status).toBe(421);
  });
});

describe("connectionsController connection health", () => {
  let prevEnv: typeof config.env;
  let prevRole: typeof config.cluster.role;

  beforeEach(() => {
    prevEnv = config.env;
    prevRole = config.cluster.role;
    config.env = "development";
    config.cluster.role = "standalone";
  });

  afterEach(() => {
    config.env = prevEnv;
    config.cluster.role = prevRole;
  });

  it("answers 404 for a phone with no live connection", async () => {
    const app = new Elysia().use(connectionsController);
    const res = await app.handle(
      new Request("http://localhost/connections/+551234567890/health", {
        method: "GET",
      }),
    );

    expect(res.status).toBe(404);
  });

  it("reports the send-side snapshot", async () => {
    const spy = spyOn(baileys, "sendHealth").mockReturnValue({
      connected: true,
      sendState: "stalled",
      consecutiveSendTimeouts: 3,
      lastTrafficAgoMs: 1200,
      lastSendCompletedAgoMs: 214_000,
      lastOutgoingAckAgoMs: 219_000,
    });

    try {
      const app = new Elysia().use(connectionsController);
      const res = await app.handle(
        new Request("http://localhost/connections/+551234567890/health", {
          method: "GET",
        }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: {
          connected: true,
          sendState: "stalled",
          consecutiveSendTimeouts: 3,
          lastTrafficAgoMs: 1200,
          lastSendCompletedAgoMs: 214_000,
          lastOutgoingAckAgoMs: 219_000,
        },
      });
    } finally {
      spy.mockRestore();
    }
  });
});
