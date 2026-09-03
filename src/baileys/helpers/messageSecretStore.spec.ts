import { afterEach, describe, expect, it } from "bun:test";
import redis from "@/lib/redis";
import {
  MESSAGE_SECRET_TTL_SECONDS,
  MESSAGE_SECRET_WRITE_SCRIPT,
  messageSecretKey,
  recallMessageSecret,
  rememberMessageSecret,
} from "./messageSecretStore";

const stringData = (redis as any).__stringData as Map<string, string>;
const hashData = (redis as any).__hashData as Map<string, Map<string, string>>;
const expirations = (redis as any).__expirations as Map<
  string,
  { type: string; value: number }
>;

const PHONE = "+5511936199421";
const MESSAGE_ID = "3EB078E05D8F792B76A79F";
const SECRET = Buffer.alloc(32, 3);

describe("messageSecretStore", () => {
  afterEach(() => {
    stringData.clear();
    hashData.clear();
    expirations.clear();
    (redis as any).__multiCommands.length = 0;
  });

  it("round-trips the secret and its authors", async () => {
    await rememberMessageSecret(PHONE, MESSAGE_ID, SECRET, [
      "167392323834034@lid",
      "553499503261@s.whatsapp.net",
    ]);

    expect(await recallMessageSecret(PHONE, MESSAGE_ID)).toEqual({
      secret: SECRET,
      senders: ["167392323834034@lid", "553499503261@s.whatsapp.net"],
    });
  });

  // A hash created by a write whose EXPIRE never landed is a key nothing will
  // ever delete, which is the whole failure the TTL exists to prevent. One
  // command, so the entry and its lifetime stand or fall together -- and a
  // script rather than a transaction, because node-redis queues a MULTI's
  // commands without the abort signal and an unbounded write is the other
  // failure this store guards against.
  it("writes the entry and its expiry as one abortable command", async () => {
    const before = (redis as any).eval.mock.calls.length;

    await rememberMessageSecret(PHONE, MESSAGE_ID, SECRET, []);

    expect((redis as any).eval.mock.calls.length).toBe(before + 1);
    expect(MESSAGE_SECRET_WRITE_SCRIPT).toContain("HSET");
    expect(MESSAGE_SECRET_WRITE_SCRIPT).toContain("EXPIRE");
  });

  // Per-message keys with no expiry would grow the keyspace by every message
  // the fleet ever receives, to serve a 15-minute edit window.
  it("expires the entry", async () => {
    await rememberMessageSecret(PHONE, MESSAGE_ID, SECRET, []);

    expect(expirations.get(messageSecretKey(PHONE, MESSAGE_ID))).toEqual({
      type: "EX",
      value: MESSAGE_SECRET_TTL_SECONDS,
    });
  });

  // Ids are unique per message, but the key is scoped per connection anyway so
  // two inboxes can never read each other's secrets.
  it("scopes the key to the connection", async () => {
    await rememberMessageSecret(PHONE, MESSAGE_ID, SECRET, []);

    expect(await recallMessageSecret("+5511999999999", MESSAGE_ID)).toBeNull();
  });

  it("answers null for a message it never saw", async () => {
    expect(await recallMessageSecret(PHONE, "unknown")).toBeNull();
  });

  // An older build of this feature stored a JSON string under the same key, and
  // those entries outlive a rollback by up to the TTL. Reading one answers
  // WRONGTYPE, which is unreadable, which is the same as absent.
  it("answers null instead of throwing on an entry it cannot read", async () => {
    const real = (redis as any).hGetAll;
    (redis as any).hGetAll = async () => {
      throw new Error(
        "WRONGTYPE Operation against a key holding the wrong kind of value",
      );
    };

    try {
      expect(await recallMessageSecret(PHONE, MESSAGE_ID)).toBeNull();
    } finally {
      (redis as any).hGetAll = real;
    }
  });

  it("answers null on an entry with no secret", async () => {
    hashData.set(
      messageSecretKey(PHONE, MESSAGE_ID),
      new Map([["jid:167392323834034@lid", "1"]]),
    );

    expect(await recallMessageSecret(PHONE, MESSAGE_ID)).toBeNull();
  });

  // The same message arrives by more than one route and they do not address its
  // author equally well: a dump whose LID mapping was unknown carries one JID
  // form where the live copy carried two. Letting the poorer copy overwrite the
  // richer one leaves an edit encrypted under the dropped form undecryptable.
  it("keeps a sender form a later, poorer copy of the message dropped", async () => {
    const lid = "167392323834034@lid";
    const pn = "553499503261@s.whatsapp.net";
    await rememberMessageSecret(PHONE, MESSAGE_ID, SECRET, [lid, pn]);

    await rememberMessageSecret(PHONE, MESSAGE_ID, SECRET, [lid]);

    const stored = await recallMessageSecret(PHONE, MESSAGE_ID);
    expect(stored?.senders.sort()).toEqual([lid, pn].sort());
  });

  // The merge is Redis's own, not a read-modify-write: setting fields only adds,
  // so a poorer copy can neither publish itself first nor lose the richer form
  // if the connection drops between two writes.
  it("never reads the entry back to merge it", async () => {
    const reads = (redis as any).hGetAll.mock.calls.length;

    await rememberMessageSecret(PHONE, MESSAGE_ID, SECRET, [
      "167392323834034@lid",
    ]);

    expect((redis as any).hGetAll.mock.calls.length).toBe(reads);
  });

  // A timeout only stops us awaiting; the command stays on node-redis's queue
  // with its payload until the connection returns. Aborting is what removes it,
  // so every command here has to carry the signal.
  it("sends its commands under an abort signal", async () => {
    const seen: AbortSignal[] = [];
    const real = (redis as any).withAbortSignal;
    (redis as any).withAbortSignal = (signal: AbortSignal) => {
      seen.push(signal);
      return redis;
    };

    try {
      await rememberMessageSecret(PHONE, MESSAGE_ID, SECRET, []);
      await recallMessageSecret(PHONE, MESSAGE_ID);
    } finally {
      (redis as any).withAbortSignal = real;
    }

    expect(seen).toHaveLength(2);
    expect(seen.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });
});
