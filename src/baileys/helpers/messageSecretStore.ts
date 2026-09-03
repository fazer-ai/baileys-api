import config from "@/config";
import redis from "@/lib/redis";

const redisKeyPrefix = "@baileys-api:connections";

// How long a secret is kept, and the window it has to cover is NOT the fifteen
// minutes WhatsApp gives an author to edit a message. An edit created well
// inside that window is only replayed to us when the connection comes back, so
// what matters is how long a disconnect may last before its history arrives —
// hours, sometimes days. A secret that expired first turns a valid edit into
// one nothing can read.
//
// Seven days is the same horizon the reconnect quarantine works on. Each entry
// is a few dozen bytes for one message, and only for messages that publish a
// secret at all.
export const MESSAGE_SECRET_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Hash field holding the base64 of the message's own messageSecret. */
const SECRET_FIELD = "secret";
/** Prefix of the hash fields holding the author's JID forms, one per field. */
const SENDER_FIELD_PREFIX = "jid:";

// node-redis parks a command on an offline queue while the connection is down
// and replays it on reconnect, so every message that publishes a secret would
// leave one more command, promise and encoded payload parked there, growing for
// as long as the outage lasts. A secret we cannot file is a future edit we
// cannot read, which is the degradation a failed write already accepts.
//
// Two guards, because neither is enough alone. The readiness check keeps the
// command from being created at all during a known outage, but it is a snapshot:
// the connection can drop between the check and the flush. The abort signal is
// what covers that, and is the only thing that actually CANCELS -- a timeout
// merely stops us awaiting, leaving the command exactly where it was.
function storeUnavailable() {
  return !redis.isReady;
}

/**
 * Writes the fields and the lifetime together.
 *
 * A script rather than a MULTI, and the reason is the abort signal rather than
 * atomicity: node-redis 6 queues a transaction's commands through
 * `_executeMulti`, which passes only `chainId` and `typeMapping`, so the signal
 * never reaches them and an unbounded write is exactly what the guards above
 * exist to prevent. EVAL is one ordinary command, so it carries the signal, and
 * a script is atomic by definition.
 *
 * The alternative -- HSET then EXPIRE as two commands -- can leave a hash whose
 * expiry never landed, which is a key nothing will ever delete.
 */
export const MESSAGE_SECRET_WRITE_SCRIPT = `
redis.call('HSET', KEYS[1], unpack(ARGV, 2))
redis.call('EXPIRE', KEYS[1], ARGV[1])
return 1
`.trim();

// Aborting removes the command from the client's pending queue and rejects it,
// so nothing is retained past the deadline the caller was willing to wait.
function bounded() {
  return redis.withAbortSignal(
    AbortSignal.timeout(config.baileys.messageSecretStoreTimeoutMs),
  );
}

// Keyed by message id alone, deliberately: the edit's targetMessageKey carries
// the chat jid as the EDITOR sees it (our own lid), which never matches the jid
// we filed the original under. Ids are random per message and the key is
// already scoped to one connection, so the id is identity enough.
export function messageSecretKey(phoneNumber: string, messageId: string) {
  return `${redisKeyPrefix}:${phoneNumber}:message-secret:${messageId}`;
}

export interface MessageSecretEntry {
  messageId: string;
  secret: Uint8Array;
  senders: string[];
}

/**
 * Files a message's secret and the JID forms its author was addressed by.
 *
 * A hash whose sender JIDs are one field each, rather than a JSON value, and
 * the shape is the whole point: the same message arrives by more than one route
 * and they do not address its author equally well, so a dump whose LID mapping
 * was unknown carries one form where the live copy carried two. Writing a value
 * means read, merge, write, which is neither atomic against a concurrent writer
 * nor safe to interrupt: the poorer list is published first and a disconnect
 * between the two writes loses the richer one for good. Setting fields only ever
 * adds, so the union is what Redis itself does and there is nothing to lose.
 *
 * The secret is not merged, it is simply written: it belongs to the message and
 * is identical on every copy.
 */
export async function rememberMessageSecret(
  phoneNumber: string,
  messageId: string,
  secret: Uint8Array,
  senders: string[],
): Promise<void> {
  if (storeUnavailable()) {
    return;
  }

  const key = messageSecretKey(phoneNumber, messageId);
  const fields: Record<string, string> = {
    [SECRET_FIELD]: Buffer.from(secret).toString("base64"),
  };
  for (const jid of senders) {
    if (jid) {
      fields[`${SENDER_FIELD_PREFIX}${jid}`] = "1";
    }
  }

  const args = [String(MESSAGE_SECRET_TTL_SECONDS)];
  for (const [field, value] of Object.entries(fields)) {
    args.push(field, value);
  }

  await bounded().eval(MESSAGE_SECRET_WRITE_SCRIPT, {
    keys: [key],
    arguments: args,
  });
}

/**
 * Files a whole batch at once. Written for a history dump, which can carry
 * thousands of messages: awaiting each write in turn would put a Redis round
 * trip between every message and the next, and hold the dump's delivery behind
 * all of them. Fired together, the client pipelines them into one flush.
 */
export async function rememberMessageSecrets(
  phoneNumber: string,
  entries: MessageSecretEntry[],
): Promise<void> {
  if (storeUnavailable()) {
    return;
  }

  await Promise.all(
    entries.map(({ messageId, secret, senders }) =>
      rememberMessageSecret(phoneNumber, messageId, secret, senders),
    ),
  );
}

export async function recallMessageSecret(
  phoneNumber: string,
  messageId: string,
): Promise<{ secret: Buffer; senders: string[] } | null> {
  if (storeUnavailable()) {
    return null;
  }

  let stored: Record<string, string> | undefined;
  try {
    stored = await bounded().hGetAll(messageSecretKey(phoneNumber, messageId));
  } catch {
    // Includes WRONGTYPE, which is what a key left by an older build of this
    // feature answers. Unreadable is the same as absent here.
    return null;
  }

  const encoded = stored?.[SECRET_FIELD];
  if (!encoded) {
    return null;
  }

  // Unordered, unlike the list this used to store. The order was only ever a
  // hint about which form to try first, and trying a wrong one costs a failed
  // GCM tag check over a handful of candidates.
  const senders = Object.keys(stored)
    .filter((field) => field.startsWith(SENDER_FIELD_PREFIX))
    .map((field) => field.slice(SENDER_FIELD_PREFIX.length));

  return { secret: Buffer.from(encoded, "base64"), senders };
}
