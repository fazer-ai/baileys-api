import { afterEach, describe, expect, it } from "bun:test";
import redis from "@/lib/redis";
import {
  MESSAGE_SECRET_TTL_SECONDS,
  messageSecretKey,
  recallMessageSecret,
  rememberMessageSecret,
} from "./messageSecretStore";

const stringData = (redis as any).__stringData as Map<string, string>;
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
    expirations.clear();
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

  it("answers null instead of throwing on a corrupt entry", async () => {
    stringData.set(messageSecretKey(PHONE, MESSAGE_ID), "not json");

    expect(await recallMessageSecret(PHONE, MESSAGE_ID)).toBeNull();
  });

  it("answers null on an entry with no secret", async () => {
    stringData.set(messageSecretKey(PHONE, MESSAGE_ID), JSON.stringify({}));

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
    expect(stored?.senders).toEqual([lid, pn]);
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

  it("does not rewrite when the new copy already covers the old", async () => {
    const lid = "167392323834034@lid";
    await rememberMessageSecret(PHONE, MESSAGE_ID, SECRET, [lid]);
    const writes = (redis as any).set.mock.calls.length;

    await rememberMessageSecret(PHONE, MESSAGE_ID, SECRET, [lid]);

    expect((redis as any).set.mock.calls.length).toBe(writes + 1);
  });
});
