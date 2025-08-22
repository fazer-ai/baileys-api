import type {
  AnyMessageContent,
  ChatModification,
  proto,
  WAPresence,
} from "@whiskeysockets/baileys";
import {
  BaileysConnection,
  BaileysNotConnectedError,
} from "@/baileys/connection";
import { getRedisSavedAuthStateIds } from "@/baileys/redisAuthState";
import type {
  BaileysConnectionOptions,
  FetchMessageHistoryOptions,
  SendReceiptsOptions,
} from "@/baileys/types";
import logger from "@/lib/logger";

export class BaileysConnectionsHandler {
  private connections: Record<string, BaileysConnection> = {};

  async reconnectFromAuthStore() {
    const savedConnections =
      await getRedisSavedAuthStateIds<
        Omit<BaileysConnectionOptions, "phoneNumber" | "onConnectionClose">
      >();

    if (savedConnections.length === 0) {
      logger.info("No saved connections to reconnect");
      return;
    }

    logger.info(
      "Reconnecting from auth store %o",
      savedConnections.map(({ id }) => id),
    );

    // TODO: Handle thundering herd issue.
    for (const { id, metadata } of savedConnections) {
      const connection = new BaileysConnection(id, {
        onConnectionClose: () => {
          delete this.connections[id];
        },
        isReconnect: true,
        ...metadata,
      });
      this.connections[id] = connection;
      await connection.connect();
    }
  }

  async connect(phoneNumber: string, options: BaileysConnectionOptions) {
    if (this.connections[phoneNumber]) {
      // NOTE: This triggers a `connection.update` event.
      await this.connections[phoneNumber].sendPresenceUpdate("available");
      return;
    }

    const connection = new BaileysConnection(phoneNumber, {
      ...options,
      onConnectionClose: () => {
        delete this.connections[phoneNumber];
        options.onConnectionClose?.();
      },
    });
    await connection.connect();
    this.connections[phoneNumber] = connection;
  }

  private getConnection(phoneNumber: string) {
    const connection = this.connections[phoneNumber];
    if (!connection) {
      throw new BaileysNotConnectedError();
    }
    return connection;
  }

  sendPresenceUpdate(
    phoneNumber: string,
    { type, toJid }: { type: WAPresence; toJid?: string | undefined },
  ) {
    return this.getConnection(phoneNumber).sendPresenceUpdate(type, toJid);
  }

  sendMessage(
    phoneNumber: string,
    {
      jid,
      messageContent,
    }: {
      jid: string;
      messageContent: AnyMessageContent;
    },
  ) {
    return this.getConnection(phoneNumber).sendMessage(jid, messageContent);
  }

  readMessages(phoneNumber: string, keys: proto.IMessageKey[]) {
    return this.getConnection(phoneNumber).readMessages(keys);
  }

  chatModify(phoneNumber: string, mod: ChatModification, jid: string) {
    return this.getConnection(phoneNumber).chatModify(mod, jid);
  }

  fetchMessageHistory(
    phoneNumber: string,
    { count, oldestMsgKey, oldestMsgTimestamp }: FetchMessageHistoryOptions,
  ) {
    return this.getConnection(phoneNumber).fetchMessageHistory(
      count,
      oldestMsgKey,
      oldestMsgTimestamp,
    );
  }

  sendReceipts(phoneNumber: string, { keys, type }: SendReceiptsOptions) {
    return this.getConnection(phoneNumber).sendReceipts(keys, type);
  }

  profilePictureUrl(
    phoneNumber: string,
    jid: string,
    type?: "preview" | "image",
  ) {
    return this.getConnection(phoneNumber).profilePictureUrl(jid, type);
  }

  onWhatsApp(phoneNumber: string, jids: string[]) {
    return this.getConnection(phoneNumber).onWhatsApp(jids);
  }

  async logout(phoneNumber: string) {
    await this.getConnection(phoneNumber).logout();
    delete this.connections[phoneNumber];
  }

  async logoutAll() {
    const connections = Object.values(this.connections);
    await Promise.allSettled(connections.map((c) => c.logout()));
    this.connections = {};
  }
}
