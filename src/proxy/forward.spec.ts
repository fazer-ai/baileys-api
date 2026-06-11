import { afterEach, describe, expect, it, mock } from "bun:test";
import config from "@/config";
import {
  forwardRequest,
  PayloadTooLargeError,
  toForwardable,
} from "@/proxy/forward";

const originalFetch = globalThis.fetch;
const originalMaxBodyBytes = config.proxy.maxBodyBytes;

afterEach(() => {
  globalThis.fetch = originalFetch;
  config.proxy.maxBodyBytes = originalMaxBodyBytes;
});

describe("proxy forward", () => {
  describe("#toForwardable", () => {
    it("buffers bodies within the replay cap", async () => {
      const request = new Request("http://proxy:3025/connections/x", {
        method: "POST",
        body: '{"jid":"a"}',
      });

      const forwardable = await toForwardable(request);

      expect(Buffer.from(forwardable.body as ArrayBuffer).toString()).toBe(
        '{"jid":"a"}',
      );
    });

    it("rejects bodies over the replay cap instead of buffering them", async () => {
      config.proxy.maxBodyBytes = 8;
      const request = new Request("http://proxy:3025/connections/x", {
        method: "POST",
        body: "123456789",
      });

      await expect(toForwardable(request)).rejects.toBeInstanceOf(
        PayloadTooLargeError,
      );
    });

    it("rejects early on a declared content-length over the cap", async () => {
      config.proxy.maxBodyBytes = 8;
      const request = new Request("http://proxy:3025/connections/x", {
        method: "POST",
        headers: { "content-length": "1000000" },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("x"));
            controller.close();
          },
        }),
      });

      await expect(toForwardable(request)).rejects.toBeInstanceOf(
        PayloadTooLargeError,
      );
    });
  });

  describe("#forwardRequest", () => {
    it("strips hop-by-hop headers, including ones named by Connection", async () => {
      let forwardedHeaders: Headers | undefined;
      let forwardedRedirect: RequestRedirect | undefined;
      globalThis.fetch = mock(
        async (_url: string | URL | Request, init?: RequestInit) => {
          forwardedHeaders = init?.headers as Headers;
          forwardedRedirect = init?.redirect;
          return new Response("ok");
        },
      ) as unknown as typeof fetch;

      await forwardRequest("http://worker-1:3025", {
        method: "GET",
        url: "http://proxy:3025/status",
        headers: new Headers({
          connection: "foo, bar",
          foo: "scoped-to-this-hop",
          bar: "scoped-to-this-hop",
          "proxy-authorization": "secret",
          "x-api-key": "key",
        }),
        body: null,
      });

      expect(forwardedHeaders?.get("x-api-key")).toBe("key");
      expect(forwardedHeaders?.get("connection")).toBeNull();
      expect(forwardedHeaders?.get("foo")).toBeNull();
      expect(forwardedHeaders?.get("bar")).toBeNull();
      expect(forwardedHeaders?.get("proxy-authorization")).toBeNull();
      // 3xx responses are relayed as-is, never followed by the proxy.
      expect(forwardedRedirect).toBe("manual");
    });
  });
});
