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
  ignoreGroups?: boolean;
  isReconnect?: boolean;
  onConnectionClose?: () => void;
}

export interface BaileysConnectionWebhookPayload {
  event: keyof BaileysEventMap;
  data: BaileysEventMap[keyof BaileysEventMap] | { error: string };
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
