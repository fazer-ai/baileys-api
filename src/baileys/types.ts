import type {
  BaileysEventMap,
  MessageReceiptType,
  proto,
} from "@whiskeysockets/baileys";
import type { BaileysHistoryFramePayload } from "@/baileys/helpers/historySync";

export interface BaileysConnectionOptions {
  clientName?: string;
  webhookUrl: string;
  webhookVerifyToken: string;
  includeMedia?: boolean;
  syncFullHistory?: boolean;
  groupsEnabled?: boolean;
  autoPresenceSubscribe?: boolean;
  apiKeyHash?: string;
  isReconnect?: boolean;
  // Import/takeover: discard any live socket and spawn a fresh one so the newly
  // seeded creds are actually loaded. A reused in-memory socket (e.g. one still
  // emitting QRs) would otherwise ignore the transplanted session. Transient —
  // stripped in connect() and never persisted onto the connection.
  forceRestart?: boolean;
  // Epoch of the lease under which this connection was claimed. Stamped onto
  // connection.update webhooks so the client can discard late events from a
  // previous owner. Threaded in by the coordinator's lease-claim path; never
  // read back from Redis (a re-read could pick up a successor's epoch).
  leaseEpoch?: number | null;
  onConnectionClose?: () => void;
  // Invoked by the connection when it must tear itself down via the handler
  // (wrong-phone-number teardown) so the logout participates in the handler's
  // inFlightOps lock instead of bypassing it. Wired by the handler, mirroring
  // onConnectionClose. See issue #313.
  requestLogout?: () => void;
  // Invoked by the connection when its sends keep timing out and the socket has
  // to be recreated. Goes through the handler for the same reason as
  // requestLogout: the restart has to participate in the handler's inFlightOps
  // lock rather than bypass it. See the send-stall watchdog in connection.ts.
  requestRestart?: (reason: string) => void;
  // Invoked when this connection gives up rebuilding its own socket and aborts.
  // The handler has evicted it by then, but the LEASE is the coordinator's: the
  // claim scan skips any phone that already has one, so without this the number
  // stays dark until the TTL and the unclaimed grace expire while requests route
  // here and 404.
  onUnrecoverable?: () => void;
}

export interface BaileysConnectionWebhookPayload {
  event: keyof BaileysEventMap;
  // connection.update events additionally carry the lease epoch so the
  // client can discard late events from a previous owner.
  data:
    | BaileysEventMap[keyof BaileysEventMap]
    | (BaileysEventMap["connection.update"] & { epoch?: number })
    // messaging-history.set is delivered in frames rather than as the raw
    // event: see historySync.ts.
    | BaileysHistoryFramePayload
    | {
        error: string;
        // Present on reconnect_loop_detected when the phone entered
        // quarantine: consecutive failed reconnect cycles and when background
        // claims will retry. Explicit POST /connections retries immediately.
        quarantine?: { strikes: number; until: string };
        // Present on send_stall_detected: the connection is receiving and
        // answering health checks but every send times out. `action` says
        // whether the socket was recreated or the restart was held back (by
        // config or by backoff), and `until` when a held-back restart may
        // next run.
        sendStall?: {
          consecutiveTimeouts: number;
          stalledForMs: number;
          action: "restart" | "suppressed" | "cancelled" | "failed";
          until?: string;
        };
      };
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

export type MessageKeyWithId = proto.IMessageKey & { id: string };
