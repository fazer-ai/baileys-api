import { afterEach, mock } from "bun:test";

/**
 * Shared test preload — runs before every test file.
 *
 * Mocks: @/lib/redis, @/lib/logger, @/config, @whiskeysockets/baileys,
 *        @/helpers/asyncSleep, @/baileys/helpers/preprocessAudio, qrcode
 *
 * Test files access mock internals through the module imports, e.g.:
 *   import redis from "@/lib/redis";
 *   const hashData = (redis as any).__hashData;
 */

// ===== @/lib/redis =====
const hashData = new Map<string, Map<string, string>>();
const stringData = new Map<string, string>();
const multiCommands: Array<{ op: string; args: any[] }> = [];
// TTL bookkeeping for SET: records the expiration option (or deletes the
// entry for persistent writes) so specs can assert whether a key was written
// with or without a TTL. Time is NOT simulated — keys never auto-expire.
const expirations = new Map<string, { type: string; value: number }>();

const mockRedis = {
  __hashData: hashData,
  __stringData: stringData,
  __multiCommands: multiCommands,
  __expirations: expirations,

  hSet: mock(async (key: string, field: string, value: string) => {
    if (!hashData.has(key)) hashData.set(key, new Map());
    hashData.get(key)?.set(field, value);
    return 1;
  }),
  hGet: mock(async (key: string, field: string) => {
    return hashData.get(key)?.get(field) ?? null;
  }),
  del: mock(async (key: string) => {
    const deletedHash = hashData.delete(key);
    const deletedString = stringData.delete(key);
    return Number(deletedHash || deletedString);
  }),
  keys: mock(async (pattern: string) => {
    const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
    return Array.from(hashData.keys()).filter((k) => regex.test(k));
  }),
  // Mirrors node-redis v6: yields SCAN reply batches (arrays of keys), not
  // individual keys. Walks the whole emulated keyspace (hashes + strings) so
  // it faithfully covers both call sites (authState hashes, instance strings).
  scanIterator: (options?: { MATCH?: string; COUNT?: number }) => {
    const pattern = options?.MATCH ?? "*";
    // Escape regex metacharacters so only "*" acts as a wildcard, matching
    // Redis glob semantics (a literal "." must not become "any char").
    const regex = new RegExp(
      `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? ".*" : `\\${c}`))}$`,
    );
    const allKeys = [...hashData.keys(), ...stringData.keys()].filter((k) =>
      regex.test(k),
    );
    const batchSize = options?.COUNT ?? 250;
    async function* generate() {
      for (let i = 0; i < allKeys.length; i += batchSize) {
        yield allKeys.slice(i, i + batchSize);
      }
    }
    return generate();
  },
  get: mock(async (key: string) => {
    return stringData.get(key) ?? null;
  }),
  set: mock(
    async (
      key: string,
      value: string,
      options?: {
        NX?: boolean;
        EX?: number;
        condition?: "NX" | "XX";
        expiration?: { type: string; value: number };
      },
    ) => {
      const nx = options?.NX || options?.condition === "NX";
      if (nx && stringData.has(key)) return null;
      stringData.set(key, value);
      if (options?.expiration) {
        expirations.set(key, options.expiration);
      } else if (options?.EX !== undefined) {
        // node-redis accepts the TTL either way; recording both is what lets a
        // spec assert that a marker was written with the lifetime it needs.
        expirations.set(key, { type: "EX", value: options.EX });
      } else {
        expirations.delete(key);
      }
      return "OK";
    },
  ),
  incr: mock(async (key: string) => {
    const next = (Number(stringData.get(key)) || 0) + 1;
    stringData.set(key, String(next));
    return next;
  }),
  exists: mock(async (key: string) => {
    return stringData.has(key) || hashData.has(key) ? 1 : 0;
  }),
  pExpire: mock(async (_key: string, _ttlMs: number) => 1),
  // -2 when the key is gone, -1 when it has no expiry, else the duration it was
  // written with. The fake has no clock, so this is the configured lifetime
  // rather than a true remaining time; a test that cares pins it per call.
  pTTL: mock(async (key: string) => {
    if (!stringData.has(key)) {
      return -2;
    }
    const expiration = expirations.get(key);
    if (!expiration) {
      return -1;
    }
    return expiration.type === "PX"
      ? expiration.value
      : expiration.value * 1000;
  }),
  ping: mock(async () => "PONG"),
  // Emulates the known Lua scripts (dispatched by distinctive content) so the
  // real redisAuthState/leaseStore code paths behave faithfully in tests.
  // Specs can still pin outcomes with mockResolvedValueOnce.
  eval: mock(
    async (
      script: string,
      options?: { keys?: string[]; arguments?: string[] },
    ) => {
      const keys = options?.keys ?? [];
      const args = options?.arguments ?? [];

      // steal-if-stale idempotency lock (compare-and-set): KEYS=[key],
      // ARGV=[expected, new, ttl]. Reclaims an orphaned "processing" marker
      // only if it still matches the value observed by the caller.
      if (script.includes("steal-if-stale")) {
        const [key] = keys;
        const [expected, newValue, ttl] = args;
        if (stringData.get(key) === expected) {
          stringData.set(key, newValue);
          // Mirror the real SET ... EX: the reclaimed marker carries a TTL.
          expirations.set(key, { type: "EX", value: Number(ttl) });
          return 1;
        }
        return 0;
      }

      // write-if-ours (compare-and-set): KEYS=[key],
      // ARGV=[ourProcessingValue, value, ttl, heldFlag]. Writes only over our own
      // processing marker (and only when we actually hold it) or over nothing,
      // so a successor's lock or cached result survives.
      if (script.includes("write-if-ours")) {
        const [key] = keys;
        const [expected, value, ttl, held] = args;
        const raw = stringData.get(key);
        if (raw === undefined || (held === "1" && raw === expected)) {
          stringData.set(key, value);
          expirations.set(key, { type: "EX", value: Number(ttl) });
          return 1;
        }
        return 0;
      }

      // release-if-ours (compare-and-delete): KEYS=[key], ARGV=[ourMarker].
      if (script.includes("release-if-ours")) {
        const [key] = keys;
        if (stringData.get(key) === args[0]) {
          stringData.delete(key);
          expirations.delete(key);
          return 1;
        }
        return 0;
      }

      // clear-indeterminate (compare-and-delete): KEYS=[key], ARGV=[marker].
      // Drops the marker only if it is still the exact one the retracting
      // attempt wrote, so neither a cached result nor a later attempt's own
      // marker goes with it. Checked before the generic DEL branch below, which
      // would otherwise claim this script.
      if (script.includes("clear-indeterminate")) {
        if (stringData.get(keys[0]) === args[0]) {
          stringData.delete(keys[0]);
          expirations.delete(keys[0]);
          return 1;
        }
        return 0;
      }

      // send-stall-cas (compare-and-set): KEYS=[key],
      // ARGV=[expected ("" for absent), value, ttlMs].
      if (script.includes("send-stall-cas")) {
        const [key] = keys;
        const [expected, value, ttl] = args;
        const raw = stringData.get(key);
        if ((raw === undefined && expected === "") || raw === expected) {
          stringData.set(key, value);
          expirations.set(key, { type: "PX", value: Number(ttl) });
          return 1;
        }
        return 0;
      }

      // send-stall-cad (compare-and-delete): KEYS=[key], ARGV=[expected].
      if (script.includes("send-stall-cad")) {
        const [key] = keys;
        if (stringData.get(key) === args[0]) {
          stringData.delete(key);
          expirations.delete(key);
          return 1;
        }
        return 0;
      }

      // advance-candidate-cas (owner-fenced compare-and-swap on creds):
      // KEYS=[hash, lease], ARGV=[owner, expectedCreds, newCreds, newCursor].
      // Checked before the generic HSET branch because this script also HSETs.
      if (script.includes("advance-candidate-cas")) {
        const [hashKey, leaseKey] = keys;
        const [owner, expectedCreds, newCreds, newCursor] = args;
        const rawLease = stringData.get(leaseKey);
        if (rawLease && JSON.parse(rawLease).owner !== owner) return 0;
        if (hashData.get(hashKey)?.get("creds") !== expectedCreds) return 2;
        if (!hashData.has(hashKey)) hashData.set(hashKey, new Map());
        hashData.get(hashKey)!.set("creds", newCreds);
        hashData.get(hashKey)!.set("import-candidates", newCursor);
        return 1;
      }

      // write-if-owner (auth state fencing): KEYS=[hash, lease], ARGV=[owner, ...pairs]
      if (script.includes("HSET")) {
        const [hashKey, leaseKey] = keys;
        const [owner, ...pairs] = args;
        const rawLease = stringData.get(leaseKey);
        if (rawLease && JSON.parse(rawLease).owner !== owner) return 0;
        // Mirror real Redis: HDEL never materializes a hash, and a hash whose
        // last field is deleted disappears (redis.keys must not see it).
        for (let i = 0; i < pairs.length - 1; i += 2) {
          if (pairs[i + 1] === "@@DEL@@") {
            const hash = hashData.get(hashKey);
            hash?.delete(pairs[i]);
            if (hash?.size === 0) hashData.delete(hashKey);
            continue;
          }
          if (!hashData.has(hashKey)) hashData.set(hashKey, new Map());
          hashData.get(hashKey)!.set(pairs[i], pairs[i + 1]);
        }
        return 1;
      }

      // clear-if-owner: KEYS=[hash, lease], ARGV=[owner]
      if (script.includes("clear-if-owner")) {
        const [hashKey, leaseKey] = keys;
        const rawLease = stringData.get(leaseKey);
        if (rawLease && JSON.parse(rawLease).owner !== args[0]) return 0;
        return hashData.delete(hashKey) ? 1 : 0;
      }

      // lease renew: KEYS=[lease], ARGV=[owner, ttlMs] → 1 | 0 | -1
      if (script.includes("PEXPIRE")) {
        const raw = stringData.get(keys[0]);
        if (!raw) return -1;
        return JSON.parse(raw).owner === args[0] ? 1 : 0;
      }

      // lease release (compare-and-delete): KEYS=[lease], ARGV=[owner, epoch]
      if (script.includes("DEL")) {
        const raw = stringData.get(keys[0]);
        if (!raw) return 0;
        const lease = JSON.parse(raw);
        if (lease.owner !== args[0]) return 0;
        if (args[1] !== undefined && String(lease.epoch) !== args[1]) return 0;
        stringData.delete(keys[0]);
        return 1;
      }

      // Fail loudly: silently succeeding would mask a missing emulation path
      // and let tests pass against behavior production does not have.
      throw new Error(
        `Unhandled redis.eval script in test preload emulator: ${script.slice(0, 80)}`,
      );
    },
  ),
  publish: mock(async (_channel: string, _message: string) => 0),
  multi: mock(() => {
    // Each multi() invocation owns its own command buffer. A shared module-level
    // buffer races when concurrent/interleaved multi() calls reset it mid-flight
    // (e.g. one pipeline's execAsPipeline awaiting while another multi() zeroes
    // the buffer), silently dropping the queued commands. The module-level
    // `multiCommands` (exposed as __multiCommands) is a pure observation log:
    // every queued command is mirrored into it so specs can assert on
    // pipeline usage, but execution reads only the local buffer.
    const commands: Array<{ op: string; args: any[] }> = [];
    const queue = (cmd: { op: string; args: any[] }) => {
      commands.push(cmd);
      multiCommands.push(cmd);
    };
    return {
      hSet: (key: string, field: string, value: string) => {
        queue({ op: "hSet", args: [key, field, value] });
      },
      hDel: (key: string, field: string) => {
        queue({ op: "hDel", args: [key, field] });
      },
      hGet: (key: string, field: string) => {
        queue({ op: "hGet", args: [key, field] });
      },
      execAsPipeline: mock(async () => {
        const results: any[] = [];
        for (const cmd of commands) {
          if (cmd.op === "hSet") {
            const [key, field, value] = cmd.args;
            if (!hashData.has(key)) hashData.set(key, new Map());
            hashData.get(key)?.set(field, value);
            results.push(1);
          } else if (cmd.op === "hDel") {
            const [key, field] = cmd.args;
            hashData.get(key)?.delete(field);
            results.push(1);
          } else if (cmd.op === "hGet") {
            const [key, field] = cmd.args;
            results.push(hashData.get(key)?.get(field) ?? null);
          }
        }
        return results;
      }),
    };
  }),
};

const mockSubscriberClient = {
  on: mock(() => {}),
  connect: mock(async () => {}),
  subscribe: mock(async () => {}),
  unsubscribe: mock(async () => {}),
  quit: mock(async () => {}),
};

mock.module("@/lib/redis", () => ({
  default: mockRedis,
  initializeRedis: mock(async () => mockRedis),
  createSubscriberClient: mock(() => mockSubscriberClient),
}));

// ===== @/lib/logger =====
// Real deepSanitizeObject implementation (pure function, safe to use in tests)
function sanitizeItem(
  item: unknown,
  options?: { omitKeys?: string[] },
): unknown {
  if (typeof item === "string") {
    return `${item.slice(0, 50)}${item.length > 50 ? "..." : ""}`;
  }
  if (Array.isArray(item) || item instanceof Set) {
    const arr = Array.from(item);
    const maxItems = 3;
    const sanitized = arr
      .slice(0, maxItems)
      .map((i) => sanitizeItem(i, options));
    if (arr.length > maxItems) {
      sanitized.push(`... and ${arr.length - maxItems} more`);
    }
    return sanitized;
  }
  if (typeof item === "object") {
    if (item === null) return item;
    return deepSanitizeObject(item as Record<string, unknown>, options);
  }
  return item;
}

function deepSanitizeObject(
  obj: Record<string, unknown>,
  options?: { omitKeys?: string[] },
) {
  const output = structuredClone(obj);
  if (options?.omitKeys) {
    for (const key in output) {
      if (options.omitKeys.includes(key)) {
        output[key] = "********";
      }
    }
  }
  for (const key in output) {
    output[key] = sanitizeItem(output[key], options);
  }
  return output;
}

mock.module("@/lib/logger", () => ({
  default: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    isLevelEnabled: () => false,
  },
  baileysLogger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
  deepSanitizeObject,
}));

// ===== @/config =====
mock.module("@/config", () => ({
  default: {
    env: "production" as "development" | "production",
    logLevel: "warn",
    baileys: {
      logLevel: "warn",
      httpTimeoutMs: 120_000,
      txAcquireTimeoutMs: 300_000,
      txHoldWarnMs: 30_000,
      audioPreprocessTimeoutMs: 20_000,
      sendTimeoutMs: 45_000,
      sendStallRestartEnabled: false,
      clientVersion: "default",
      overrideClientVersion: false,
      ignoreGroupMessages: false,
      ignoreStatusMessages: true,
      ignoreBroadcastMessages: true,
      ignoreNewsletterMessages: true,
      ignoreBotMessages: true,
      ignoreMetaAiMessages: true,
      listenToEvents: new Set<string>(),
    },
    webhook: {
      timeoutMs: 60_000,
      historyFrameMaxBytes: 512 * 1024,
      retryPolicy: {
        maxRetries: 0,
        retryInterval: 10,
        backoffFactor: 2,
      },
    },
    redis: {
      url: "redis://localhost:6379",
      password: "test-password",
    },
    media: {
      cleanupEnabled: false,
      cleanupIntervalMs: 60 * 60 * 1000,
      maxAgeHours: 24,
    },
    cluster: {
      role: "standalone" as "standalone" | "worker" | "proxy",
      instanceId: "test-instance",
      workerBaseUrl: undefined as string | undefined,
      leaseTtlMs: 30_000,
      leaseRenewIntervalMs: 10_000,
      claimIntervalMs: 5_000,
      claimJitterMs: 2_000,
      reconnectConcurrency: 5,
      unclaimedGraceMs: 30_000,
      releaseCooldownMs: 60_000,
      rebalanceEnabled: true,
      rebalanceReleaseIntervalMs: 10_000,
      rebalanceTolerance: 1,
      rebalanceIdleThresholdMs: 300_000,
      heartbeatIntervalMs: 5_000,
      instanceTtlMs: 15_000,
      shutdownTimeoutMs: 30_000,
      quarantineEnabled: true,
      quarantineBaseMs: 60_000,
      quarantineMaxMs: 3_600_000,
    },
    proxy: {
      routeCacheTtlMs: 50,
      requestTimeoutMs: 1_000,
      maxBodyBytes: 1024 * 1024,
    },
  },
}));

// ===== @/helpers/asyncSleep =====
mock.module("@/helpers/asyncSleep", () => ({
  asyncSleep: mock(async () => {}),
}));

// ===== @/baileys/helpers/preprocessAudio =====
mock.module("@/baileys/helpers/preprocessAudio", () => ({
  preprocessAudio: mock(async (_buf: Buffer) => Buffer.from("processed")),
}));

// fetchBaileysClientVersion — NOT mocked; its dependencies (baileys, config, logger) are mocked above,
// so the real function runs safely in tests.

// ===== qrcode =====
mock.module("qrcode", () => ({
  toDataURL: mock(async () => "data:image/png;base64,qrcode"),
}));

// ===== @whiskeysockets/baileys =====
const mockEventHandlers = new Map<string, (...args: never[]) => unknown>();

function createMockSocket() {
  return {
    ev: {
      on: mock((event: string, handler: (...args: never[]) => unknown) => {
        mockEventHandlers.set(event, handler);
      }),
      removeAllListeners: mock(() => {}),
    },
    logout: mock(async () => {}),
    sendMessage: mock(async () => ({ key: { id: "sent-1" } })),
    sendPresenceUpdate: mock(async () => {}),
    readMessages: mock(async () => {}),
    chatModify: mock(async () => {}),
    fetchMessageHistory: mock(async () => {}),
    sendReceipts: mock(async () => {}),
    profilePictureUrl: mock(async () => "https://example.com/pic.jpg"),
    fetchAccountReachoutTimelock: mock(async () => ({
      isActive: false,
      enforcementType: "DEFAULT",
    })),
    fetchNewChatMessageCap: mock(async () => ({
      total_quota: 100,
      used_quota: 0,
      capping_status: "NONE",
    })),
    onWhatsApp: mock(async () => []),
    getBusinessProfile: mock(async () => {}),
    groupMetadata: mock(async () => {}),
    groupParticipantsUpdate: mock(async () => {}),
    user: { id: "5511999999999:0@s.whatsapp.net" },
    authState: { creds: { me: { id: "5511999999999:0@s.whatsapp.net" } } },
    groupCreate: mock(async () => {}),
    groupLeave: mock(async () => {}),
    groupUpdateSubject: mock(async () => {}),
    groupUpdateDescription: mock(async () => {}),
    groupRequestParticipantsList: mock(async () => []),
    groupRequestParticipantsUpdate: mock(async () => {}),
    groupInviteCode: mock(async () => "invite-code"),
    groupRevokeInvite: mock(async () => "new-invite"),
    groupAcceptInvite: mock(async () => "group-jid"),
    groupRevokeInviteV4: mock(async () => {}),
    groupAcceptInviteV4: mock(async () => "group-jid"),
    groupGetInviteInfo: mock(async () => ({})),
    groupToggleEphemeral: mock(async () => {}),
    groupSettingUpdate: mock(async () => {}),
    groupMemberAddMode: mock(async () => {}),
    groupJoinApprovalMode: mock(async () => {}),
    groupFetchAllParticipating: mock(async () => ({})),
    presenceSubscribe: mock(async () => {}),
    signalRepository: {
      lidMapping: {
        getPNForLID: mock(async () => null),
        getLIDForPN: mock(async () => null),
        getPNsForLIDs: mock(async () => null),
      },
    },
  };
}

// Track the latest socket created by makeWASocket.
// __mockSocket is a Proxy that delegates to the latest instance so that
// tests can assert on it without knowing which socket object the connection holds.
let _latestMockSocket = createMockSocket();
const mockSocket = new Proxy({} as ReturnType<typeof createMockSocket>, {
  get(_, prop) {
    return (_latestMockSocket as any)[prop];
  },
  set(_, prop, value) {
    (_latestMockSocket as any)[prop] = value;
    return true;
  },
});

mock.module("@whiskeysockets/baileys", () => ({
  __mockSocket: mockSocket,
  __mockEventHandlers: mockEventHandlers,
  default: mock(() => {
    _latestMockSocket = createMockSocket();
    return _latestMockSocket;
  }),
  Browsers: { windows: (name: string) => ["Windows", name, "10"] },
  DisconnectReason: {
    loggedOut: 401,
    badSession: 500,
    connectionReplaced: 440,
  },
  WAMessageStatus: {
    ERROR: 0,
    PENDING: 1,
    SERVER_ACK: 2,
    DELIVERY_ACK: 3,
    READ: 4,
    PLAYED: 5,
  },
  makeCacheableSignalKeyStore: mock((keys: any) => keys),
  fetchLatestWaWebVersion: mock(async () => ({ version: [2, 2400, 0] })),
  isJidGroup: (jid: string) => jid?.endsWith("@g.us") ?? false,
  isJidStatusBroadcast: (jid: string) => jid === "status@broadcast",
  isJidBroadcast: (jid: string) => jid?.endsWith("@broadcast") ?? false,
  isJidNewsletter: (jid: string) => jid?.endsWith("@newsletter") ?? false,
  isJidBot: (jid: string) => jid?.endsWith("@bot") ?? false,
  isJidMetaAI: (jid: string) => jid?.endsWith("@lid") ?? false,
  downloadContentFromMessage: mock(async () => {
    async function* generate() {
      yield Buffer.from("chunk1");
      yield Buffer.from("chunk2");
    }
    return generate();
  }),
  // Faithful reimplementation of 7.0.0-rc14's normalizeMessageContent
  // (getFutureProofMessage wrapper list, bounded loop).
  normalizeMessageContent: (content: any) => {
    let current = content;
    if (!current) return undefined;
    for (let i = 0; i < 5; i++) {
      const inner =
        current?.ephemeralMessage ||
        current?.viewOnceMessage ||
        current?.documentWithCaptionMessage ||
        current?.viewOnceMessageV2 ||
        current?.viewOnceMessageV2Extension ||
        current?.editedMessage ||
        current?.associatedChildMessage ||
        current?.groupStatusMessage ||
        current?.groupStatusMessageV2;
      if (!inner) break;
      current = inner.message;
    }
    return current;
  },
  initAuthCreds: mock(() => ({
    noiseKey: { private: "noise-priv", public: "noise-pub" },
    pairingEphemeralKeyPair: { private: "pair-priv", public: "pair-pub" },
    signedIdentityKey: { private: "id-priv", public: "id-pub" },
    signedPreKey: {
      keyPair: { private: "pre-priv", public: "pre-pub" },
      signature: "sig",
    },
    registrationId: 12345,
    advSecretKey: "adv-secret",
    nextPreKeyId: 1,
    firstUnuploadedPreKeyId: 1,
    accountSyncCounter: 0,
    accountSettings: { unarchiveChats: false },
  })),
  BufferJSON: {
    replacer: (_key: string, value: any) => value,
    reviver: (_key: string, value: any) => value,
  },
  proto: {
    HistorySync: {
      HistorySyncType: {
        INITIAL_BOOTSTRAP: 0,
        INITIAL_STATUS_V3: 1,
        FULL: 2,
        RECENT: 3,
        PUSH_NAME: 4,
        NON_BLOCKING_DATA: 5,
        ON_DEMAND: 6,
      },
    },
    Message: {
      AppStateSyncKeyData: {
        fromObject: (obj: any) => ({ ...obj, __appStateSyncKey: true }),
      },
    },
  },
}));

// ===== Global cleanup =====
afterEach(() => {
  hashData.clear();
  stringData.clear();
  expirations.clear();
  multiCommands.length = 0;
  mockEventHandlers.clear();
});
