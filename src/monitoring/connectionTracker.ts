import logger from "@/lib/logger";

export class ConnectionTracker {
  private static instance: ConnectionTracker;
  private connections: Map<
    string,
    {
      createdAt: number;
      lastActivity: number;
      eventListenerCount?: number;
    }
  > = new Map();

  static getInstance(): ConnectionTracker {
    if (!ConnectionTracker.instance) {
      ConnectionTracker.instance = new ConnectionTracker();
    }
    return ConnectionTracker.instance;
  }

  trackConnection(phoneNumber: string) {
    this.connections.set(phoneNumber, {
      createdAt: Date.now(),
      lastActivity: Date.now(),
    });
    logger.debug(
      "Tracking connection: %s (Total: %d)",
      phoneNumber,
      this.connections.size,
    );
  }

  updateActivity(phoneNumber: string) {
    const connection = this.connections.get(phoneNumber);
    if (connection) {
      connection.lastActivity = Date.now();
    }
  }

  removeConnection(phoneNumber: string) {
    const connection = this.connections.get(phoneNumber);
    if (connection) {
      const lifetime = Date.now() - connection.createdAt;
      logger.debug(
        "Connection removed: %s (Lifetime: %d ms)",
        phoneNumber,
        lifetime,
      );
      this.connections.delete(phoneNumber);
    }
  }

  getConnectionReport() {
    const now = Date.now();
    const report = Array.from(this.connections.entries()).map(
      ([phone, conn]) => ({
        phoneNumber: phone,
        lifetimeMs: now - conn.createdAt,
        lastActivityMs: now - conn.lastActivity,
        isStale: now - conn.lastActivity > 300000, // 5 minutes
      }),
    );

    return {
      totalConnections: this.connections.size,
      connections: report,
      staleConnections: report.filter((c) => c.isStale).length,
    };
  }

  logPeriodicReport() {
    const report = this.getConnectionReport();
    logger.info(
      "Connection Report: %d active, %d stale",
      report.totalConnections,
      report.staleConnections,
    );

    if (report.staleConnections > 0) {
      logger.warn("Stale connections detected - potential memory leak");
    }
  }
}
