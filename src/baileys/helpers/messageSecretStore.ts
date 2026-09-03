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

export interface StoredMessageSecret {
  /** base64 of the original message's messageContextInfo.messageSecret */
  secret: string;
  /**
   * JIDs the original message's author was addressed by, most authoritative
   * first. More than one because a chat mid-LID-migration reports the same
   * person as `<lid>@lid` and `<phone>@s.whatsapp.net`, and only one of them
   * is the string WhatsApp fed into the key derivation.
   */
  senders: string[];
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

// node-redis parks a command on an offline queue while the connection is down
// and replays it on reconnect. `withTimeout` stops us AWAITING the command; it
// cannot cancel it, so every message that publishes a secret would leave one
// more command, promise and encoded payload parked there, growing for as long
// as the outage lasts. A secret we cannot file is a future edit we cannot read,
// which is the degradation a failed write already accepts.
function storeUnavailable() {
  return !redis.isReady;
}

export async function rememberMessageSecret(
  phoneNumber: string,
  messageId: string,
  secret: Uint8Array,
  senders: string[],
): Promise<void> {
  if (storeUnavailable()) {
    return;
  }

  const payload: StoredMessageSecret = {
    secret: Buffer.from(secret).toString("base64"),
    senders,
  };
  await redis.set(
    messageSecretKey(phoneNumber, messageId),
    JSON.stringify(payload),
    { expiration: { type: "EX", value: MESSAGE_SECRET_TTL_SECONDS } },
  );
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

  const raw = await redis.get(messageSecretKey(phoneNumber, messageId));
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as StoredMessageSecret;
    if (!parsed?.secret) {
      return null;
    }
    return {
      secret: Buffer.from(parsed.secret, "base64"),
      senders: Array.isArray(parsed.senders) ? parsed.senders : [],
    };
  } catch {
    return null;
  }
}
