import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
// Deep specifier on purpose, as in linkPreviewTimeout.spec.ts: the preload
// mocks "@whiskeysockets/baileys", and the package has no "exports" map, so
// this path resolves the real, patched file.
import { getUrlInfo } from "@whiskeysockets/baileys/lib/Utils/link-preview.js";

// The bug (#413): link-preview-js clears its timer when the headers arrive and
// then buffers the whole body with response.text(), whatever its type or size.
// A link to a multi-GB file took the process to 14 GB RSS and the host to OOM.
// The fetch stub below counts the body bytes the code under test actually
// read, so the tests measure the download itself, not only the returned value.

const CHUNK = Buffer.alloc(64 * 1024, 0x61);
const MiB = 1024 * 1024;
const CAP = 5 * MiB;

let read: Record<string, number> = {};

// Writes forever, as fast as the socket drains: only the client hanging up
// stops it.
const writeForever = (res: ServerResponse) => {
  const pump = () => {
    while (!res.destroyed && res.write(CHUNK)) {}
  };
  res.on("drain", pump);
  pump();
};

// Re-exposes a body pulling from upstream only when the consumer reads, and
// counts what was handed over.
const counted = (route: string, body: ReadableStream<Uint8Array> | null) => {
  if (!body) return null;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) return controller.close();
        read[route] = (read[route] ?? 0) + value.byteLength;
        controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
};

const html = (title: string) =>
  `<!doctype html><html><head><title>${title}</title>` +
  `<meta property="og:title" content="${title}">` +
  `<meta property="og:description" content="A small page"></head>` +
  "<body>hello</body></html>";

let server: Server;
let local: string;
const originalFetch = globalThis.fetch;
// link-preview-js refuses loopback and private hosts, so the tests use a public
// looking origin and route it to the local server here, signal included.
const base = "https://files.example.com";

// node:http rather than Bun.serve: Bun.serve drops a declared content-length
// on a streamed body and sends it chunked, and one route needs the header.
beforeAll(async () => {
  server = createServer((req, res) => {
    switch (req.url) {
      case "/page":
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html("Small page"));
        return;
      case "/backup.zip":
        res.writeHead(200, { "content-type": "application/zip" });
        writeForever(res);
        return;
      case "/declared-huge.html":
        // Declares 8 GiB; the client must refuse it from the header alone.
        res.writeHead(200, {
          "content-type": "text/html",
          "content-length": String(8 * 1024 * MiB),
        });
        writeForever(res);
        return;
      case "/endless.html":
        res.writeHead(200, { "content-type": "text/html" });
        writeForever(res);
        return;
      case "/slow.html": {
        // Headers right away, then a body that trickles forever.
        res.writeHead(200, { "content-type": "text/html" });
        const timer = setInterval(() => res.write("<p>x</p>"), 50);
        res.on("close", () => clearInterval(timer));
        return;
      }
      default:
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const route = new URL(url).pathname;
    return originalFetch(url.replace(base, local), init).then((response) => {
      const wrapped = new Response(counted(route, response.body), {
        status: response.status,
        headers: response.headers,
      });
      // A constructed Response has an empty url; a real fetch reports the
      // address it fetched, and link-preview-js parses relative to it.
      Object.defineProperty(wrapped, "url", { value: url });
      return wrapped;
    });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  server.closeAllConnections();
  server.close();
});

// Raced so that the old behaviour (never settling) fails the assertion instead
// of hanging the suite.
const settle = async (url: string, timeout = 300) => {
  const started = performance.now();
  const outcome = await Promise.race([
    getUrlInfo(url, {
      thumbnailWidth: 192,
      fetchOpts: { timeout },
    } as never).then(
      (info) => ({ state: "resolved" as const, info }),
      (error: Error) => ({ state: "rejected" as const, error }),
    ),
    Bun.sleep(3000).then(() => ({ state: "hung" as const })),
  ]);
  return { ...outcome, ms: performance.now() - started };
};

describe("link preview body limits", () => {
  it("keeps the preview of a normal HTML page", async () => {
    const result = await settle(`${base}/page`);
    expect(result.state).toBe("resolved");
    if (result.state !== "resolved") return;
    expect(result.info?.title).toBe("Small page");
    expect(result.info?.description).toBe("A small page");
  });

  it("does not download a non-HTML file to preview it", async () => {
    read = {};
    const result = await settle(`${base}/backup.zip`);
    expect(result.state).toBe("resolved");
    if (result.state !== "resolved") return;
    expect(result.info).toBeUndefined();
    expect(read["/backup.zip"] ?? 0).toBe(0);
  });

  it("refuses an HTML response whose declared length is over the cap", async () => {
    read = {};
    const result = await settle(`${base}/declared-huge.html`);
    expect(result.state).toBe("resolved");
    if (result.state !== "resolved") return;
    expect(result.info).toBeUndefined();
    expect(read["/declared-huge.html"] ?? 0).toBe(0);
  });

  it("stops reading an HTML body once it passes the cap", async () => {
    read = {};
    // A generous budget, so that only the cap can end the read.
    const result = await settle(`${base}/endless.html`, 2500);
    expect(result.state).toBe("resolved");
    if (result.state !== "resolved") return;
    expect(result.info).toBeUndefined();
    // One network read can overshoot the cap; the bound is the cap plus slack.
    expect(read["/endless.html"] ?? 0).toBeLessThanOrEqual(CAP + MiB);
  });

  it("applies the timeout to the body, not only to the headers", async () => {
    const result = await settle(`${base}/slow.html`, 200);
    expect(result.state).not.toBe("hung");
    // Budget plus slack for the event loop; the old code never settled.
    expect(result.ms).toBeLessThan(1500);
  });
});
