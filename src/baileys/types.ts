import type {
  BaileysEventMap,
  MessageReceiptType,
  proto,
} from "@whiskeysockets/baileys";

export interface BaileysConnectionOptions {
  clientName?: string;
  webhookUrl: string;
  webhookVerifyToken: string;
  includeMedia?: boolean;
  syncFullHistory?: boolean;
  // When > 0, the `messaging-history.set` event is filtered to messages
  // within the last N days, sorted chronologically and batched into
  // `messages.upsert` webhooks tagged with `importMode: true`. Targeted at
  // downstream consumers (e.g. Chatwoot) that want to backfill historical
  // chats through their normal incoming-message pipeline without flooding
  // it with thousands of events at once.
  historyImportDays?: number;
  groupsEnabled?: boolean;
  autoPresenceSubscribe?: boolean;
  apiKeyHash?: string;
  isReconnect?: boolean;
  // Epoch of the lease under which this connection was claimed. Stamped onto
  // connection.update webhooks so the client can discard late events from a
  // previous owner. Threaded in by the coordinator's lease-claim path; never
  // read back from Redis (a re-read could pick up a successor's epoch).
  leaseEpoch?: number | null;
  onConnectionClose?: () => void;
}

export interface BaileysConnectionWebhookPayload {
  event: keyof BaileysEventMap;
  // connection.update events additionally carry the lease epoch so the
  // client can discard late events from a previous owner.
  data:
    | BaileysEventMap[keyof BaileysEventMap]
    | (BaileysEventMap["connection.update"] & { epoch?: number })
    | { error: string };
  extra?: unknown;
  // Set on every webhook produced by the history-import backfill path so
  // the consumer can suppress live-only side effects (notifications,
  // automations, outbound webhooks, read receipts) for old messages.
  importMode?: boolean;
  importBatch?: {
    index: number;
    total: number;
    phase: "history";
  };
}

export interface FetchMessageHistoryOptions {
  count: number;
  oldestMsgKey: proto.IMessageKey;
  oldestMsgTimestamp: number;
}

export interface SendReceiptsOptions {
  keys: proto.IMessageKey[];
  type?: MessageReceiptType;
}

export type MessageKeyWithId = proto.IMessageKey & { id: string };
