import {
  BaileysConnection,
  type BaileysConnectionOptions,
  BaileysNotConnectedError,
} from "@/baileys/connection";
import { getRedisSavedAuthStateIds } from "@/baileys/redisAuthState";
import logger from "@/lib/logger";
import type { AnyMessageContent, WAPresence } from "@whiskeysockets/baileys";

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
      const connection = new BaileysConnection({
        phoneNumber: id,
        onConnectionClose: () => delete this.connections[id],
        isReconnect: true,
        ...metadata,
      });
      this.connections[id] = connection;
      await connection.connect();
    }
  }

  async connect(options: BaileysConnectionOptions) {
    const { phoneNumber } = options;
    if (this.connections[phoneNumber]) {
      // NOTE: This triggers a `connection.update` event.
      await this.connections[phoneNumber].sendPresenceUpdate("available");
      return;
    }

    const connection = new BaileysConnection({
      ...options,
      onConnectionClose: () => {
        delete this.connections[phoneNumber];
        options.onConnectionClose?.();
      },
    });
    await connection.connect();
    this.connections[phoneNumber] = connection;
  }

  sendPresenceUpdate(
    phoneNumber: string,
    { type, toJid }: { type: WAPresence; toJid?: string | undefined },
  ) {
    const connection = this.connections[phoneNumber];
    if (!connection) {
      throw new BaileysNotConnectedError();
    }

    return connection.sendPresenceUpdate(type, toJid);
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
    const connection = this.connections[phoneNumber];
    if (!connection) {
      throw new BaileysNotConnectedError();
    }

    return connection.sendMessage(jid, messageContent);
  }

  readMessages(
    phoneNumber: string,
    keys: {
      remoteJid?: string;
      fromMe?: boolean;
      id?: string;
      participant?: string;
    }[],
  ) {
    const connection = this.connections[phoneNumber];
    if (!connection) {
      throw new BaileysNotConnectedError();
    }

    return connection.readMessages(keys);
  }

  async logout(phoneNumber: string) {
    const connection = this.connections[phoneNumber];
    if (!connection) {
      throw new BaileysNotConnectedError();
    }

    await connection.logout();
    delete this.connections[phoneNumber];
  }

  async logoutAll() {
    const connections = Object.values(this.connections);
    await Promise.allSettled(connections.map((c) => c.logout()));
    this.connections = {};
  }
}
