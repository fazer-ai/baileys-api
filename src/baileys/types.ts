import type { BaileysEventMap, proto } from "@whiskeysockets/baileys";

export interface BaileysConnectionOptions {
  clientName?: string;
  webhookUrl: string;
  webhookVerifyToken: string;
  includeMedia?: boolean;
  syncFullHistory?: boolean;
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
