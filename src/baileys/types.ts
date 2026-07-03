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
  // Import/takeover: discard any live socket and spawn a fresh one so the newly
  // seeded creds are actually loaded. A reused in-memory socket (e.g. one still
  // emitting QRs) would otherwise ignore the transplanted session. Transient —
  // stripped in connect() and never persisted onto the connection.
  forceRestart?: boolean;
  // Epoch of the lease under which this connection was claimed. Stamped onto
  // connection.update webhooks so the client can discard late events from a
  // previous owner. Threaded in by the coordinator's lease-claim path; never
  // read back from Redis (a re-read could pick up a successor's epoch).
  leaseEpoch?: number | null;
  onConnectionClose?: () => void;
  // Invoked by the connection when it must tear itself down via the handler
  // (wrong-phone-number teardown) so the logout participates in the handler's
  // inFlightOps lock instead of bypassing it. Wired by the handler, mirroring
  // onConnectionClose. See issue #313.
  requestLogout?: () => void;
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
