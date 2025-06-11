import type { BaileysEventMap, proto } from "@whiskeysockets/baileys";

export interface ExternalBaileysConnectionOptions {
  clientName?: string;
  webhookUrl: string;
  webhookVerifyToken: string;
  includeMedia?: boolean;
  syncFullHistory?: boolean;
}

export type BaileysConnectionOptions = ExternalBaileysConnectionOptions & {
  isReconnect?: boolean;
  onConnectionClose?: () => void;
};

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
