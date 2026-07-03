import {
  type AuthenticationCreds,
  type AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import { instanceId } from "@/cluster/identity";
import { clusterKeys } from "@/cluster/keys";
import logger from "@/lib/logger";
import redis from "@/lib/redis";
import { scanKeys } from "@/lib/scanKeys";

const redisKeyPrefix = "@baileys-api:connections";

// Sentinel for field deletion inside a fenced batch. JSON.stringify output is
// always quoted, so a bare token can never collide with a real value.
const DELETE_SENTINEL = "@@DEL@@";

// Owner-fenced hash write. During a split-brain window two instances can hold
// sockets for the same identity; last-writer-wins on Signal session keys
// regresses the ratchet and produces undecryptable messages ("Bad MAC" /
// "waiting for this message"). The fence makes the zombie's writes no-ops:
// only the lease owner mutates the auth state. A missing lease does NOT block
// the write — there is no competing owner to protect, and rejecting would
// lose ratchet updates during the window between lease expiry and re-assert.
const WRITE_IF_OWNER_SCRIPT = `
local raw = redis.call('GET', KEYS[2])
if raw then
  local lease = cjson.decode(raw)
  if lease.owner ~= ARGV[1] then return 0 end
end
for i = 2, #ARGV - 1, 2 do
  if ARGV[i + 1] == '${DELETE_SENTINEL}' then
    redis.call('HDEL', KEYS[1], ARGV[i])
  else
    redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1])
  end
end
return 1
`;

// Same fence for the destructive path: a discarded instance that processes a
// late loggedOut must not DEL the auth hash out from under the live owner.
// The "-- clear-if-owner" marker keeps the script distinguishable for the
// test-side Lua emulation.
const CLEAR_IF_OWNER_SCRIPT = `
-- clear-if-owner
local raw = redis.call('GET', KEYS[2])
if raw then
  local lease = cjson.decode(raw)
  if lease.owner ~= ARGV[1] then return 0 end
end
return redis.call('DEL', KEYS[1])
`;

// Owner-fenced compare-and-swap for advancing an import candidate. The caller
// mutates creds.noiseKey in JS (BufferJSON, which Redis-side cjson cannot round
// -trip without corrupting empty arrays like processedHistoryMessages) and then
// commits here ONLY if the stored creds still byte-match what it read — so a
// concurrent saveCreds is never clobbered. KEYS=[hash, lease],
// ARGV=[owner, expectedCreds, newCreds, newCursor].
// Returns: 0 fenced off, 1 written, 2 creds changed under us (caller retries).
const ADVANCE_CANDIDATE_CAS_SCRIPT = `
-- advance-candidate-cas
local raw = redis.call('GET', KEYS[2])
if raw then
  local lease = cjson.decode(raw)
  if lease.owner ~= ARGV[1] then return 0 end
end
if redis.call('HGET', KEYS[1], 'creds') ~= ARGV[2] then return 2 end
redis.call('HSET', KEYS[1], 'creds', ARGV[3], 'import-candidates', ARGV[4])
return 1
`;

// `pairs` alternates field, value (value = DELETE_SENTINEL deletes the field).
// Returns false when the write was fenced off (lease owned by someone else).
async function fencedAuthWrite(id: string, pairs: string[]): Promise<boolean> {
  if (pairs.length === 0) {
    return true;
  }
  const result = await redis.eval(WRITE_IF_OWNER_SCRIPT, {
    keys: [`${redisKeyPrefix}:${id}:authState`, clusterKeys.lease(id)],
    arguments: [instanceId, ...pairs],
  });
  if (result !== 1) {
    logger.warn(
      "[%s] [fencedAuthWrite] write rejected — lease is owned by another instance",
      id,
    );
    return false;
  }
  return true;
}

// Fenced like the Signal keys, but for a different reason: metadata
// (webhookUrl, verify token, apiKeyHash) is also written by automatic
// reconnects and option updates on reused connections, and a zombie socket
// acting after losing its lease would replay stale config over a newer
// client-driven update on the new owner. The fence makes that replay a
// no-op; client requests always reach the lease owner (proxy routing /
// standalone self-ownership), so legitimate updates are never rejected.
// Shared by useRedisAuthState and BaileysConnection.persistMetadata so
// every metadata write goes through the same fence.
export async function writeAuthMetadata(
  id: string,
  metadata: unknown,
): Promise<boolean> {
  return fencedAuthWrite(id, ["metadata", JSON.stringify(metadata)]);
}

const IMPORT_CANDIDATES_FIELD = "import-candidates";

interface ImportCandidateState {
  candidates: { private: string; public: string }[];
  index: number;
}

// Transplants an already-linked WhatsApp Web session before a connect: writes
// the mapped creds AND the Noise-candidate cursor in a SINGLE fenced write, so
// an import can never land with creds persisted but no candidates (or vice
// versa) if the process dies between two writes. The next connect resumes the
// session (creds.me set -> no QR) and can cycle candidates if the seeded Noise
// key is the wrong one (only one candidate is the real private->public pair;
// the extractor cannot tell which). Serialized identically to saveCreds so
// useRedisAuthState reads it back verbatim. The caller must hold the lease —
// the import path runs this right after forceAcquireLease — otherwise the write
// is fenced off and this returns false (do not connect: the socket would resume
// stale/empty creds).
export async function seedImportedSession(
  id: string,
  creds: AuthenticationCreds,
  candidates: { private: string; public: string }[],
  index: number,
): Promise<boolean> {
  return fencedAuthWrite(id, [
    "creds",
    JSON.stringify(creds, BufferJSON.replacer),
    IMPORT_CANDIDATES_FIELD,
    JSON.stringify({ candidates, index } satisfies ImportCandidateState),
  ]);
}

// Advances a seeded import to the next Noise candidate: rewrites creds.noiseKey
// and bumps the stored cursor so the next connect() (which re-reads creds from
// Redis) resumes with the new key. Returns false when nothing is seeded or the
// candidates are exhausted — the caller then falls back to the normal reconnect.
//
// The read-modify-write of creds is committed via an owner-fenced compare-and
// -swap: the noiseKey mutation happens in JS (BufferJSON), then the write lands
// only if the stored creds still match what we read. This keeps a concurrent
// saveCreds (which also writes the creds field) from being clobbered by our
// stale-but-for-noiseKey copy; on a mismatch we re-read and recompute. A few
// attempts is ample — the only writer that can race here is this connection's
// own saveCreds during a pre-open reconnect, not a hot loop.
export async function advanceImportCandidate(id: string): Promise<boolean> {
  const key = `${redisKeyPrefix}:${id}:authState`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = await redis.hGet(key, IMPORT_CANDIDATES_FIELD);
    if (!raw) {
      return false;
    }
    const state = JSON.parse(raw) as ImportCandidateState;
    const nextIndex = state.index + 1;
    const next = state.candidates[nextIndex];
    if (!next) {
      return false;
    }

    const credsRaw = await redis.hGet(key, "creds");
    if (!credsRaw) {
      return false;
    }
    const creds = JSON.parse(
      credsRaw,
      BufferJSON.reviver,
    ) as AuthenticationCreds;
    (creds as { noiseKey: unknown }).noiseKey = {
      private: Buffer.from(next.private, "base64"),
      public: Buffer.from(next.public, "base64"),
    };

    const result = await redis.eval(ADVANCE_CANDIDATE_CAS_SCRIPT, {
      keys: [key, clusterKeys.lease(id)],
      arguments: [
        instanceId,
        credsRaw,
        JSON.stringify(creds, BufferJSON.replacer),
        JSON.stringify({
          candidates: state.candidates,
          index: nextIndex,
        } satisfies ImportCandidateState),
      ],
    });

    if (result === 1) {
      return true;
    }
    if (result === 0) {
      // Fenced off — another instance owns the lease; do not retry.
      logger.warn(
        "[%s] [advanceImportCandidate] write rejected — lease is owned by another instance",
        id,
      );
      return false;
    }
    // result === 2: creds changed under us (concurrent saveCreds) — re-read.
  }
  logger.warn(
    "[%s] [advanceImportCandidate] creds kept changing under the compare-and-swap; skipping candidate advance this cycle",
    id,
  );
  return false;
}

// Clears the import candidate cursor once the session opens (or on teardown):
// later reconnects of a healthy session must not cycle its Noise key.
export async function clearImportCandidates(id: string): Promise<boolean> {
  return fencedAuthWrite(id, [IMPORT_CANDIDATES_FIELD, DELETE_SENTINEL]);
}

// NOTE: Inspired by https://github.com/hbinduni/baileys-redis-auth
export async function useRedisAuthState(
  id: string,
  metadata?: unknown,
): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  const createKey = (key: string) => `${redisKeyPrefix}:${id}:${key}`;

  const writeData = (_key: string, field: string, data: unknown) =>
    fencedAuthWrite(id, [field, JSON.stringify(data, BufferJSON.replacer)]);

  const readData = async (key: string, field: string) => {
    const data = await redis.hGet(createKey(key), field);
    return data ? JSON.parse(data, BufferJSON.reviver) : null;
  };

  const creds: AuthenticationCreds =
    (await readData("authState", "creds")) || initAuthCreds();

  // Skipped entirely when no metadata was given: JSON.stringify(undefined)
  // is undefined, which is not a valid hash value (and would clobber the
  // stored copy anyway).
  if (metadata !== undefined) {
    await writeAuthMetadata(id, metadata);
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data: { [_: string]: SignalDataTypeMap[typeof type] } = {};
          await Promise.all(
            ids.map(async (id) => {
              const value = await readData("authState", `${type}-${id}`);
              data[id] =
                type === "app-state-sync-key" && value
                  ? proto.Message.AppStateSyncKeyData.fromObject(value)
                  : value;
            }),
          );
          return data;
        },
        set: async (data) => {
          type DataKey = keyof typeof data;
          const pairs: string[] = [];
          for (const category in data) {
            for (const dataId in data[category as DataKey]) {
              const field = `${category}-${dataId}`;
              const value = data[category as DataKey]?.[dataId];
              pairs.push(
                field,
                value
                  ? JSON.stringify(value, BufferJSON.replacer)
                  : DELETE_SENTINEL,
              );
            }
          }
          await fencedAuthWrite(id, pairs);
        },
        clear: async () => {
          const result = await redis.eval(CLEAR_IF_OWNER_SCRIPT, {
            keys: [createKey("authState"), clusterKeys.lease(id)],
            arguments: [instanceId],
          });
          if (result === 0) {
            logger.warn(
              "[%s] [clearAuthState] clear rejected — lease is owned by another instance",
              id,
            );
          }
        },
      },
    },
    saveCreds: async () => {
      await writeData("authState", "creds", creds);
    },
  };
}

// A paired auth state has registered with WhatsApp (creds.me is set after the
// QR scan completes). Unpaired states have nothing to resume — reconnecting
// them only generates a fresh QR nobody is looking at.
export async function isRedisAuthStatePaired(id: string): Promise<boolean> {
  const data = await redis.hGet(`${redisKeyPrefix}:${id}:authState`, "creds");
  if (!data) {
    return false;
  }
  try {
    const creds = JSON.parse(data) as { me?: { id?: string } };
    return Boolean(creds?.me?.id);
  } catch {
    return false;
  }
}

export async function getRedisAuthMetadata<T>(id: string): Promise<T | null> {
  const data = await redis.hGet(
    `${redisKeyPrefix}:${id}:authState`,
    "metadata",
  );
  return data ? JSON.parse(data) : null;
}

export async function getRedisSavedAuthStateIds<T>(): Promise<
  Array<{ id: string; metadata: T }>
> {
  const keys = await scanKeys(`${redisKeyPrefix}:*:authState`);
  const ids = keys.map((key) => key.split(":").at(-2) ?? "").filter(Boolean);

  const multi = redis.multi();
  for (const id of ids) {
    multi.hGet(`${redisKeyPrefix}:${id}:authState`, "metadata");
  }
  const metadata = await multi.execAsPipeline();
  return ids
    .map((id, i) => ({
      id,
      metadata: metadata[i] ? JSON.parse(metadata[i].toString()) : null,
    }))
    .filter((item) => item.metadata);
}
