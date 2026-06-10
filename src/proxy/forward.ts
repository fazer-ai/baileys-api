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

export interface ForwardableRequest {
  method: string;
  url: string;
  headers: Headers;
  body: ArrayBuffer | null;
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
    body: hasBody ? await request.arrayBuffer() : null,
  };
}

export async function forwardRequest(
  baseUrl: string,
  request: ForwardableRequest,
): Promise<Response> {
  const url = new URL(request.url);
  const target = `${baseUrl}${url.pathname}${url.search}`;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!STRIPPED_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });

  return fetch(target, {
    method: request.method,
    headers,
    body: request.body ?? undefined,
    signal: AbortSignal.timeout(config.proxy.requestTimeoutMs),
  });
}
