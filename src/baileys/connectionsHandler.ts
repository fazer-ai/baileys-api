import type {
  AnyMessageContent,
  ChatModification,
  ParticipantAction,
  proto,
  WAMessage,
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
  MessageKeyWithId,
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
      "Reconnecting %d connections from auth store %o",
      savedConnections.length,
      savedConnections.map(({ id }) => id),
    );

    // TODO: Handle thundering herd issue.
    for (const { id, metadata } of savedConnections) {
      const connection = new BaileysConnection(id, {
        onConnectionClose: () => {
          delete this.connections[id];
          logger.debug(
            "Now tracking %d connections",
            Object.keys(this.connections).length,
          );
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
      this.connections[phoneNumber].updateOptions(options);
      try {
        // NOTE: This triggers a `connection.update` event.
        await this.connections[phoneNumber].sendPresenceUpdate("available");
        return;
      } catch (error) {
        if (!(error instanceof BaileysNotConnectedError)) {
          throw error;
        }
        delete this.connections[phoneNumber];
        logger.debug(
          "Handled inconsistent connection state for %s",
          phoneNumber,
        );
      }
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
    logger.debug(
      "Now tracking %d connections",
      Object.keys(this.connections).length,
    );
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
      quoted,
    }: {
      jid: string;
      messageContent: AnyMessageContent;
      quoted?: WAMessage;
    },
  ) {
    return this.getConnection(phoneNumber).sendMessage(jid, messageContent, {
      quoted,
    });
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

  deleteMessage(
    phoneNumber: string,
    { jid, key }: { jid: string; key: MessageKeyWithId },
  ) {
    return this.getConnection(phoneNumber).deleteMessage(jid, key);
  }

  editMessage(
    phoneNumber: string,
    {
      jid,
      key,
      messageContent,
    }: {
      jid: string;
      key: proto.IMessageKey;
      messageContent: AnyMessageContent;
    },
  ) {
    return this.getConnection(phoneNumber).editMessage(
      jid,
      key,
      messageContent,
    );
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

  groupMetadata(phoneNumber: string, jid: string) {
    return this.getConnection(phoneNumber).groupMetadata(jid);
  }

  groupParticipants(
    phoneNumber: string,
    jid: string,
    participants: string[],
    action: ParticipantAction,
  ) {
    return this.getConnection(phoneNumber).groupParticipants(
      jid,
      participants,
      action,
    );
  }

  groupUpdateSubject(phoneNumber: string, jid: string, subject: string) {
    return this.getConnection(phoneNumber).groupUpdateSubject(jid, subject);
  }

  groupUpdateDescription(
    phoneNumber: string,
    jid: string,
    description?: string,
  ) {
    return this.getConnection(phoneNumber).groupUpdateDescription(
      jid,
      description,
    );
  }

  async logout(phoneNumber: string) {
    await this.getConnection(phoneNumber).logout();
    delete this.connections[phoneNumber];
    logger.debug(
      "Now tracking %d connections",
      Object.keys(this.connections).length,
    );
  }

  async logoutAll() {
    const connections = Object.values(this.connections);
    await Promise.allSettled(connections.map((c) => c.logout()));
    this.connections = {};
  }
}
