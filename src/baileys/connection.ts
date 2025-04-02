import { useRedisAuthState } from "@/baileys/redisAuthState";
import config from "@/config";
import { PhoneStatusNotFoundError } from "@/controller/common";
import logger, { baileysLogger, deepSanitizeObject } from "@/lib/logger";
import type { Boom } from "@hapi/boom";
import makeWASocket, {
  type AuthenticationState,
  type BaileysEventMap,
  type WAPresence,
  type ConnectionState,
  type WAConnectionState,
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import { toDataURL } from "qrcode";

export interface BaileysConnectionOptions {
  clientName?: string;
  phoneNumber: string;
  webhookUrl: string;
  webhookVerifyToken: string;
  isReconnect?: boolean;
  onConnectionClose?: () => void;
}

export class BaileysAlreadyConnectedError extends Error {
  constructor() {
    super("Phone number already connected");
  }
}
export class BaileysNotConnectedError extends Error {
  constructor() {
    super("Phone number not connected");
  }
}

export class BaileysConnection {
  private LOGGER_OMIT_KEYS = ["qr", "qrDataUrl"];

  private clientName: string;
  private phoneNumber: string;
  private webhookUrl: string;
  private webhookVerifyToken: string;
  private isReconnect: boolean;
  private onConnectionClose: (() => void) | null;
  private socket: ReturnType<typeof makeWASocket> | null;
  private clearAuthState: AuthenticationState["keys"]["clear"] | null;

  constructor(options: BaileysConnectionOptions) {
    this.clientName = options.clientName || "Chrome";
    this.phoneNumber = options.phoneNumber;
    this.webhookUrl = options.webhookUrl;
    this.webhookVerifyToken = options.webhookVerifyToken;
    this.onConnectionClose = options.onConnectionClose || null;
    this.socket = null;
    this.clearAuthState = null;
    this.isReconnect = !!options.isReconnect;
  }

  async connect() {
    if (this.socket) {
      throw new BaileysAlreadyConnectedError();
    }

    const { state, saveCreds } = await useRedisAuthState(this.phoneNumber, {
      clientName: this.clientName,
      webhookUrl: this.webhookUrl,
      webhookVerifyToken: this.webhookVerifyToken,
    });
    this.clearAuthState = state.keys.clear;

    this.socket = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger: baileysLogger,
      browser: Browsers.windows(this.clientName),
      // TODO: Remove this and drop qrcode-terminal dependency.
      printQRInTerminal: config.baileys.printQr,
    });

    this.socket.ev.on("creds.update", saveCreds);
    this.socket.ev.on("connection.update", (event) =>
      this.handleConnectionUpdate(event),
    );
    this.socket.ev.on("messages.upsert", (event) =>
      this.handleMessagesUpsert(event),
    );
    this.socket.ev.on("messages.update", (event) =>
      this.handleMessagesUpdate(event),
    );
    this.socket.ev.on("message-receipt.update", (event) =>
      this.handleMessageReceiptUpdate(event),
    );
  }

  async fetchStatus(jid: string) {
    if (!this.socket) {
      throw new BaileysNotConnectedError();
    }

    const status = await this.socket.fetchStatus(jid);
    if (!status) {
      throw new PhoneStatusNotFoundError();
    }

    return status;
  }

  private async close() {
    await this.clearAuthState?.();
    this.clearAuthState = null;
    this.socket = null;
    this.onConnectionClose?.();
  }

  async logout() {
    if (!this.socket) {
      throw new BaileysNotConnectedError();
    }

    await this.socket.logout();
    await this.close();
  }

  sendMessage(remoteJid: string, conversation: string) {
    if (!this.socket) {
      throw new BaileysNotConnectedError();
    }

    return this.socket.sendMessage(remoteJid, { text: conversation });
  }

  sendPresenceUpdate(type: WAPresence, toJid?: string | undefined) {
    if (!this.socket) {
      throw new BaileysNotConnectedError();
    }

    if (!this.socket.authState.creds.me) {
      return;
    }

    return this.socket.sendPresenceUpdate(type, toJid);
  }

  private async handleConnectionUpdate(data: Partial<ConnectionState>) {
    const { connection, qr, lastDisconnect, isNewLogin, isOnline } = data;

    // NOTE: Reconnection flow
    // - `isNewLogin`: sent after close on first connection (see `shouldReconnect` below). We send a `reconnecting` update to indicate qr code has been read.
    // - `connection === "connecting"` sent on:
    //   - Server boot, so check for `this.isReconnect`
    //   - Right after new login, specifically with `qr` code but no value present
    const isReconnecting =
      isNewLogin ||
      (connection === "connecting" &&
        (("qr" in data && !qr) || this.isReconnect));
    if (isReconnecting) {
      this.isReconnect = false;
      this.handleReconnecting();
      return;
    }

    if (connection === "close") {
      // TODO: Drop @hapi/boom dependency.
      const error = lastDisconnect?.error as Boom;
      const statusCode = error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        this.handleReconnecting();
        this.socket = null;
        this.connect();
        return;
      }
      await this.close();
    }

    if (connection === "open" && this.socket?.user?.id) {
      const phoneNumberFromId = `+${this.socket.user.id.split("@")[0].split(":")[0]}`;
      if (phoneNumberFromId !== this.phoneNumber) {
        this.handleWrongPhoneNumber();
        return;
      }
    }

    if (qr) {
      Object.assign(data, {
        connection: "connecting",
        qrDataUrl: await toDataURL(qr),
      });
    }

    if (isOnline) {
      Object.assign(data, { connection: "open" });
    }

    this.sendToWebhook({
      event: "connection.update",
      data,
    });
  }

  private handleMessagesUpsert(data: BaileysEventMap["messages.upsert"]) {
    this.sendToWebhook({
      event: "messages.upsert",
      data,
    });
  }

  private handleMessagesUpdate(data: BaileysEventMap["messages.update"]) {
    this.sendToWebhook({
      event: "messages.update",
      data,
    });
  }

  private handleMessageReceiptUpdate(
    data: BaileysEventMap["message-receipt.update"],
  ) {
    this.sendToWebhook({
      event: "message-receipt.update",
      data,
    });
  }

  private handleWrongPhoneNumber() {
    this.sendToWebhook({
      event: "connection.update",
      data: { error: "wrong_phone_number" },
    });
    this.socket?.ev.removeAllListeners("connection.update");
    this.logout();
  }

  private handleReconnecting() {
    this.sendToWebhook({
      event: "connection.update",
      data: { connection: "reconnecting" as WAConnectionState },
    });
  }

  private async sendToWebhook(payload: {
    event: keyof BaileysEventMap;
    data: BaileysEventMap[keyof BaileysEventMap] | { error: string };
  }) {
    logger.debug(
      "[%s] [sendToWebhook] %o",
      this.phoneNumber,
      deepSanitizeObject(payload, { omitKeys: this.LOGGER_OMIT_KEYS }),
    );
    try {
      await fetch(this.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...payload,
          webhookVerifyToken: this.webhookVerifyToken,
        }),
      });
    } catch (error) {
      const e = error as Error;
      logger.error("Failed to send to webhook:\n%s", e.stack || e.message);
    }
  }
}
