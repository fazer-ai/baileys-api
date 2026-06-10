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

const mockRedis = {
  __hashData: hashData,
  __stringData: stringData,
  __multiCommands: multiCommands,

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
  get: mock(async (key: string) => {
    return stringData.get(key) ?? null;
  }),
  set: mock(
    async (
      key: string,
      value: string,
      options?: { NX?: boolean; EX?: number; condition?: "NX" | "XX" },
    ) => {
      const nx = options?.NX || options?.condition === "NX";
      if (nx && stringData.has(key)) return null;
      stringData.set(key, value);
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

      // write-if-owner (auth state fencing): KEYS=[hash, lease], ARGV=[owner, ...pairs]
      if (script.includes("HSET")) {
        const [hashKey, leaseKey] = keys;
        const [owner, ...pairs] = args;
        const rawLease = stringData.get(leaseKey);
        if (rawLease && JSON.parse(rawLease).owner !== owner) return 0;
        if (!hashData.has(hashKey)) hashData.set(hashKey, new Map());
        const hash = hashData.get(hashKey)!;
        for (let i = 0; i < pairs.length - 1; i += 2) {
          if (pairs[i + 1] === "@@DEL@@") hash.delete(pairs[i]);
          else hash.set(pairs[i], pairs[i + 1]);
        }
        return 1;
      }

      // lease renew: KEYS=[lease], ARGV=[owner, ttlMs] → 1 | 0 | -1
      if (script.includes("PEXPIRE")) {
        const raw = stringData.get(keys[0]);
        if (!raw) return -1;
        return JSON.parse(raw).owner === args[0] ? 1 : 0;
      }

      // lease release (compare-and-delete): KEYS=[lease], ARGV=[owner]
      if (script.includes("DEL")) {
        const raw = stringData.get(keys[0]);
        if (!raw || JSON.parse(raw).owner !== args[0]) return 0;
        stringData.delete(keys[0]);
        return 1;
      }

      return 1;
    },
  ),
  publish: mock(async (_channel: string, _message: string) => 0),
  multi: mock(() => {
    // Each multi() invocation owns its own command buffer. A shared module-level
    // buffer races when concurrent/interleaved multi() calls reset it mid-flight
    // (e.g. one pipeline's execAsPipeline awaiting while another multi() zeroes
    // the buffer), silently dropping the queued commands.
    const commands: Array<{ op: string; args: any[] }> = [];
    return {
      hSet: (key: string, field: string, value: string) => {
        commands.push({ op: "hSet", args: [key, field, value] });
      },
      hDel: (key: string, field: string) => {
        commands.push({ op: "hDel", args: [key, field] });
      },
      hGet: (key: string, field: string) => {
        commands.push({ op: "hGet", args: [key, field] });
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
      heartbeatIntervalMs: 5_000,
      instanceTtlMs: 15_000,
      shutdownTimeoutMs: 30_000,
    },
    proxy: {
      routeCacheTtlMs: 50,
      requestTimeoutMs: 1_000,
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
  multiCommands.length = 0;
  mockEventHandlers.clear();
});
