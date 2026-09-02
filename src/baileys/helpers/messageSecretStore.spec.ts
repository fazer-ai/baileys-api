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
});
