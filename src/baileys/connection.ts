import { downloadMediaFromMessages } from "@/baileys/helpers/downloadMediaFromMessages";
import { normalizeBrazilPhoneNumber } from "@/baileys/helpers/normalizeBrazilPhoneNumber";
import { preprocessAudio } from "@/baileys/helpers/preprocessAudio";
import { useRedisAuthState } from "@/baileys/redisAuthState";
import type {
  BaileysConnectionOptions,
  BaileysConnectionWebhookPayload,
} from "@/baileys/types";
import config from "@/config";
import { asyncSleep } from "@/helpers/asyncSleep";
import { errorToString } from "@/helpers/errorToString";
import logger, { baileysLogger, deepSanitizeObject } from "@/lib/logger";
import type { Boom } from "@hapi/boom";
import makeWASocket, {
  type AnyMessageContent,
  type AuthenticationState,
  type BaileysEventMap,
  type ConnectionState,
  type WAConnectionState,
  type WAPresence,
  type proto,
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import { toDataURL } from "qrcode";

export class BaileysNotConnectedError extends Error {
  constructor() {
    super("Phone number not connected");
  }
}

export class BaileysConnection {
  private LOGGER_OMIT_KEYS = [
    "qr",
    "qrDataUrl",
    "fileSha256",
    "jpegThumbnail",
    "fileEncSha256",
    "scansSidecar",
    "midQualityFileSha256",
    "mediaKey",
    "senderKeyHash",
    "recipientKeyHash",
    "messageSecret",
    "thumbnailSha256",
    "thumbnailEncSha256",
    "appStateSyncKeyShare",
  ];

  private clientName: string;
  private phoneNumber: string;
  private webhookUrl: string;
  private webhookVerifyToken: string;
  private isReconnect: boolean;
  private includeMedia: boolean;
  private onConnectionClose: (() => void) | null;
  private socket: ReturnType<typeof makeWASocket> | null;
  private clearAuthState: AuthenticationState["keys"]["clear"] | null;
  private clearOnlinePresenceTimeout: NodeJS.Timer | null = null;

  constructor(options: BaileysConnectionOptions) {
    this.clientName = options.clientName || "Chrome";
    this.phoneNumber = options.phoneNumber;
    this.webhookUrl = options.webhookUrl;
    this.webhookVerifyToken = options.webhookVerifyToken;
    this.onConnectionClose = options.onConnectionClose || null;
    this.socket = null;
    this.clearAuthState = null;
    this.isReconnect = !!options.isReconnect;
    // TODO(v2): Change default to false.
    this.includeMedia = options.includeMedia ?? true;
  }

  async connect() {
    if (this.socket) {
      return;
    }

    const { state, saveCreds } = await useRedisAuthState(this.phoneNumber, {
      clientName: this.clientName,
      webhookUrl: this.webhookUrl,
      webhookVerifyToken: this.webhookVerifyToken,
      includeMedia: this.includeMedia,
    });
    this.clearAuthState = state.keys.clear;

    this.socket = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      markOnlineOnConnect: false,
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

  async sendMessage(jid: string, messageContent: AnyMessageContent) {
    if (!this.socket) {
      throw new BaileysNotConnectedError();
    }

    let waveformProxy: Buffer | null = null;
    try {
      if ("audio" in messageContent && Buffer.isBuffer(messageContent.audio)) {
        // NOTE: Sent audio is always mp3.
        // Due to limitations in internal Baileys logic used to generate waveform, we use a wav proxy.
        [messageContent.audio, waveformProxy] = await Promise.all([
          preprocessAudio(
            messageContent.audio,
            // NOTE: Use low quality mp3 for ptt messages for more realistic quality.
            messageContent.ptt ? "mp3-low" : "mp3-high",
          ),
          messageContent.ptt
            ? preprocessAudio(messageContent.audio, "wav")
            : null,
        ]);
        messageContent.mimetype = "audio/mpeg";
      }
    } catch (error) {
      // NOTE: This usually means ffmpeg is not installed.
      logger.error(
        "[%s] [sendMessage] [ERROR] error=%s",
        this.phoneNumber,
        errorToString(error),
      );
    }

    return this.socket.sendMessage(jid, messageContent, {
      waveformProxy,
    });
  }

  sendPresenceUpdate(type: WAPresence, toJid?: string | undefined) {
    if (!this.socket) {
      throw new BaileysNotConnectedError();
    }
    if (!this.socket.authState.creds.me) {
      return;
    }

    return this.socket.sendPresenceUpdate(type, toJid).then(() => {
      if (
        this.clearOnlinePresenceTimeout &&
        ["unavailable", "available"].includes(type)
      ) {
        clearTimeout(this.clearOnlinePresenceTimeout);
        this.clearOnlinePresenceTimeout = null;
      }
      if (type === "available") {
        this.clearOnlinePresenceTimeout = setTimeout(() => {
          this.socket?.sendPresenceUpdate("unavailable", toJid);
        }, 60000);
      }
    });
  }

  readMessages(keys: proto.IMessageKey[]) {
    if (!this.socket) {
      throw new BaileysNotConnectedError();
    }

    return this.socket.readMessages(keys);
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
      if (
        normalizeBrazilPhoneNumber(phoneNumberFromId) !==
        normalizeBrazilPhoneNumber(this.phoneNumber)
      ) {
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

  private async handleMessagesUpsert(data: BaileysEventMap["messages.upsert"]) {
    const payload: BaileysConnectionWebhookPayload = {
      event: "messages.upsert",
      data,
    };

    const media = await downloadMediaFromMessages(data.messages, {
      includeMedia: this.includeMedia,
    });
    if (media) {
      payload.extra = { media };
    }

    this.sendToWebhook(payload);
  }

  private handleMessagesUpdate(data: BaileysEventMap["messages.update"]) {
    this.sendToWebhook(
      {
        event: "messages.update",
        data,
      },
      {
        awaitResponse: true,
      },
    );
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

  private async sendToWebhook(
    payload: BaileysConnectionWebhookPayload,
    options?: {
      awaitResponse?: boolean;
    },
  ) {
    const sanitizedPayload = deepSanitizeObject(
      { ...payload },
      {
        omitKeys: this.LOGGER_OMIT_KEYS,
      },
    );

    logger.debug(
      "[%s] [sendToWebhook] (options: %o) payload=%o",
      this.phoneNumber,
      options || {},
      sanitizedPayload,
    );

    const { maxRetries, retryInterval, backoffFactor } =
      config.webhook.retryPolicy;
    let attempt = 0;
    let delay = retryInterval;

    while (attempt <= maxRetries) {
      const { response, error } = await this.sendPayloadToWebhook(
        payload,
        options,
      );
      if (response) {
        if (response.ok) {
          logger.debug(
            "[%s] [sendToWebhook] [SUCCESS] payload=%o response=%o",
            this.phoneNumber,
            sanitizedPayload,
            response,
          );
          return response;
        }
        logger.error(
          "[%s] [sendToWebhook] [ERROR] payload=%o response=%o",
          this.phoneNumber,
          sanitizedPayload,
          { status: response.status, statusText: response.statusText },
        );
      }

      if (error) {
        logger.error(
          "[%s] [sendToWebhook] [ERROR] payload=%o error=%s",
          this.phoneNumber,
          sanitizedPayload,
          errorToString(error),
        );
      }

      attempt++;
      if (attempt <= maxRetries) {
        logger.info(
          "[%s] [sendToWebhook] [RETRYING] payload=%o attempt=%d/%d delay=%dms",
          this.phoneNumber,
          sanitizedPayload,
          attempt,
          maxRetries,
          delay,
        );
        const jitter = Math.floor(Math.random() * 1000);
        await asyncSleep(delay + jitter);
        delay *= backoffFactor;
      }
    }

    logger.error(
      "[%s] [sendToWebhook] [FAILED] payload=%o",
      this.phoneNumber,
      sanitizedPayload,
    );
  }

  private async sendPayloadToWebhook(
    payload: BaileysConnectionWebhookPayload,
    options?: {
      awaitResponse?: boolean;
    },
  ): Promise<{ response?: Response; error?: Error }> {
    try {
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...payload,
          webhookVerifyToken: this.webhookVerifyToken,
          awaitResponse: options?.awaitResponse,
        }),
      });
      return { response };
    } catch (error) {
      return { error: error as Error };
    }
  }
}
