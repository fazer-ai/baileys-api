import type { BaileysEventMap } from "@whiskeysockets/baileys";

export interface BaileysConnectionOptions {
  clientName?: string;
  webhookUrl: string;
  webhookVerifyToken: string;
  isReconnect?: boolean;
  includeMedia?: boolean;
  onConnectionClose?: () => void;
}

export interface BaileysConnectionWebhookPayload {
  event: keyof BaileysEventMap;
  data: BaileysEventMap[keyof BaileysEventMap] | { error: string };
  extra?: unknown;
}
