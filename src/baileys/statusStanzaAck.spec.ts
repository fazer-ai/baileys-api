import { afterEach, describe, expect, it } from "bun:test";
// Deep specifiers on purpose. The preload mocks "@whiskeysockets/baileys", so
// importing the package would hand us the fake socket and never exercise the
// patch. The package has no "exports" map, so these paths resolve the real,
// patched files.
import makeWASocket from "@whiskeysockets/baileys/lib/Socket/index.js";
import { initAuthCreds } from "@whiskeysockets/baileys/lib/Utils/auth-utils.js";
import { decodeBinaryNode } from "@whiskeysockets/baileys/lib/WABinary/decode.js";
import pino from "pino";

type Node = { tag: string; attrs: Record<string, string>; content?: unknown };

// A WebSocket server that never answers the Noise handshake. Until the
// handshake finishes the client frames its nodes in plaintext, so everything
// it sends after the ClientHello can be decoded back into binary nodes.
function startFakeWhatsApp() {
  const sent: Node[] = [];
  let messages = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      async message(_ws, data) {
        messages += 1;
        // First message is the intro header plus the ClientHello.
        if (messages === 1 || typeof data === "string") return;
        let buf = Buffer.from(data);
        while (buf.length >= 3) {
          const len = (buf[0] << 16) | (buf[1] << 8) | buf[2];
          sent.push((await decodeBinaryNode(buf.subarray(3, 3 + len))) as Node);
          buf = buf.subarray(3 + len);
        }
      },
    },
  });
  return { server, sent, url: `ws://127.0.0.1:${server.port}/ws/chat` };
}

const errors: unknown[] = [];
const logger = pino(
  { level: "error" },
  { write: (line: string) => errors.push(JSON.parse(line)) },
);

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  errors.length = 0;
});

async function openSocket() {
  const fake = startFakeWhatsApp();
  const sock = makeWASocket({
    waWebSocketUrl: fake.url,
    auth: {
      // A paired companion: sendMessageAck reads creds.me.id.
      creds: {
        ...initAuthCreds(),
        me: { id: "5511999999999:1@s.whatsapp.net" },
      },
      keys: { get: async () => ({}), set: async () => {} },
    },
    logger: logger as never,
    connectTimeoutMs: 20_000,
    markOnlineOnConnect: false,
  });
  const deadline = Date.now() + 5_000;
  while (!sock.ws.isOpen) {
    if (Date.now() > deadline) throw new Error("socket never opened");
    await Bun.sleep(5);
  }
  cleanup = async () => {
    sock.ev.removeAllListeners(undefined as never);
    sock.end(undefined);
    fake.server.stop(true);
  };
  return { sock, sent: fake.sent };
}

async function waitForAck(sent: Node[], id: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const ack = sent.find((n) => n.tag === "ack" && n.attrs.id === id);
    if (ack) return ack;
    await Bun.sleep(5);
  }
  return undefined;
}

// Without an ack the server ends the stream ~50 min later with
// <stream:error><ack class="status" .../></stream:error>, which Baileys maps
// to a 500 and reconnects, every 50 minutes (issue #404).
describe("<status> stanza ack patch", () => {
  it("acks a live <status> stanza with class=status and the stanza's type", async () => {
    const { sock, sent } = await openSocket();
    const node = {
      tag: "status",
      attrs: {
        id: "AC8DEF6EC37673CAA121EFA6FB9A88DB",
        from: "status@broadcast",
        type: "media",
      },
    };

    sock.ws.emit("CB:status", node);

    const ack = await waitForAck(sent, node.attrs.id);
    expect(ack?.attrs).toEqual({
      id: node.attrs.id,
      to: "status@broadcast",
      class: "status",
      type: "media",
    });
  });

  it("acks an offline <status> through the offline queue without an unknown-type error", async () => {
    const { sock, sent } = await openSocket();
    const node = {
      tag: "status",
      attrs: {
        id: "ACC83980E6C6F5C998DC25C2C65F89F3",
        from: "status@broadcast",
        type: "text",
        offline: "1",
      },
    };

    sock.ws.emit("CB:status", node);

    const ack = await waitForAck(sent, node.attrs.id);
    expect(ack?.attrs.class).toBe("status");
    expect(ack?.attrs.type).toBe("text");
    expect(JSON.stringify(errors)).not.toContain("unknown offline node type");
  });

  // The offline replay is ordered: a <status> queued behind a notification is
  // acked after it, not ahead of the queue.
  it("keeps an offline <status> in order behind the offline nodes queued before it", async () => {
    const { sock, sent } = await openSocket();
    const notification = {
      tag: "notification",
      attrs: {
        id: "NOTIF-1",
        from: "5511888888888@s.whatsapp.net",
        type: "unknown",
        t: "1793635690",
        offline: "1",
      },
    };
    const status = {
      tag: "status",
      attrs: {
        id: "STATUS-1",
        from: "status@broadcast",
        type: "media",
        offline: "1",
      },
    };

    sock.ws.emit("CB:notification", notification);
    sock.ws.emit("CB:status", status);

    expect(await waitForAck(sent, "STATUS-1")).toBeDefined();
    expect(await waitForAck(sent, "NOTIF-1")).toBeDefined();
    const order = sent.filter((n) => n.tag === "ack").map((n) => n.attrs.id);
    expect(order.indexOf("NOTIF-1")).toBeLessThan(order.indexOf("STATUS-1"));
  });
});
