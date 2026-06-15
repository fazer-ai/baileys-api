import config from "@/config";

// End-to-end headers only; hop-by-hop headers describe THIS connection and
// must not be replayed to the worker. host/content-length are recomputed by
// fetch for the new target.
const STRIPPED_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export class PayloadTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(`Request body exceeds the ${limitBytes}-byte limit`);
  }
}

export interface ForwardableRequest {
  method: string;
  url: string;
  headers: Headers;
  body: ArrayBuffer | null;
}

// Buffering is capped: the proxy is the cluster's entry point, and a few
// concurrent unbounded uploads could exhaust its memory before any worker
// applies its own body limit.
async function readBodyBounded(
  request: Request,
  maxBytes: number,
): Promise<ArrayBuffer> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PayloadTooLargeError(maxBytes);
  }

  const reader = request.body?.getReader();
  if (!reader) {
    return new ArrayBuffer(0);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new PayloadTooLargeError(maxBytes);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer as ArrayBuffer;
}

// The body is buffered up front (not streamed) on purpose: a 421/409 from a
// worker triggers a single re-send to the real owner, and a consumed stream
// cannot be replayed.
export async function toForwardable(
  request: Request,
): Promise<ForwardableRequest> {
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return {
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: hasBody
      ? await readBodyBounded(request, config.proxy.maxBodyBytes)
      : null,
  };
}

export async function forwardRequest(
  baseUrl: string,
  request: ForwardableRequest,
): Promise<Response> {
  const url = new URL(request.url);
  const target = `${baseUrl}${url.pathname}${url.search}`;

  // RFC 9110 §7.6.1: headers named by the Connection header are hop-by-hop
  // too, even when they are not in the static denylist.
  const connectionScopedHeaders = new Set(
    (request.headers.get("connection") ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (
      !STRIPPED_HEADERS.has(normalized) &&
      !connectionScopedHeaders.has(normalized)
    ) {
      headers.set(key, value);
    }
  });

  return fetch(target, {
    method: request.method,
    headers,
    body: request.body ?? undefined,
    // Relay 3xx responses as-is instead of following them — the client must
    // see exactly what the worker answered.
    redirect: "manual",
    signal: AbortSignal.timeout(config.proxy.requestTimeoutMs),
  });
}
