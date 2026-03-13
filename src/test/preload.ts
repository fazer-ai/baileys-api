import { mock } from "bun:test";

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
    hashData.delete(key);
    return 1;
  }),
  keys: mock(async (pattern: string) => {
    const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
    return Array.from(hashData.keys()).filter((k) => regex.test(k));
  }),
  get: mock(async (key: string) => {
    return stringData.get(key) ?? null;
  }),
  multi: mock(() => {
    multiCommands.length = 0;
    return {
      hSet: (key: string, field: string, value: string) => {
        multiCommands.push({ op: "hSet", args: [key, field, value] });
      },
      hDel: (key: string, field: string) => {
        multiCommands.push({ op: "hDel", args: [key, field] });
      },
      hGet: (key: string, field: string) => {
        multiCommands.push({ op: "hGet", args: [key, field] });
      },
      execAsPipeline: mock(async () => {
        const results: any[] = [];
        for (const cmd of multiCommands) {
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

mock.module("@/lib/redis", () => ({ default: mockRedis }));

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
    return Array.from(item).map((i) => sanitizeItem(i, options));
  }
  if (typeof item === "object") {
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
const mockSocket = {
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
};

mock.module("@whiskeysockets/baileys", () => ({
  __mockSocket: mockSocket,
  __mockEventHandlers: mockEventHandlers,
  default: mock(() => mockSocket),
  Browsers: { windows: (name: string) => ["Windows", name, "10"] },
  DisconnectReason: { loggedOut: 401, badSession: 500 },
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
