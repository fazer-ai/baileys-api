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
