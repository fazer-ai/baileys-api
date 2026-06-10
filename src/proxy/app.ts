import cors from "@elysiajs/cors";
import Elysia, { t } from "elysia";
import { instanceId, role } from "@/cluster/identity";
import config from "@/config";
import statusController from "@/controllers/status";
import { errorToString } from "@/helpers/errorToString";
import logger from "@/lib/logger";
import { adminGuard, authMiddleware } from "@/middlewares/auth";
import { PayloadTooLargeError } from "@/proxy/forward";
import {
  fanOutToAllInstances,
  forwardByPhone,
  forwardMediaRequest,
} from "@/proxy/router";

// The proxy is the single client-facing entry point of a cluster: stateless,
// resolves which worker owns each phone via Redis and forwards byte-for-byte.
// Request bodies are NOT schema-validated here — the workers keep the
// TypeBox validation, and duplicating the schemas would let them drift.
//
// API keys are checked at the proxy too (cheap, bounces invalid traffic
// before it touches workers), and again at the workers — defense in depth.
const proxyApp = new Elysia()
  .onAfterResponse(({ request, response, set }) => {
    // Path only: the phone number is this codebase's log correlation key
    // (workers log it on every connection line), but query strings carry
    // arbitrary client data and stay out of the access log.
    logger.info(
      "%s %s [%d]",
      request.method,
      new URL(request.url).pathname,
      (response as Response)?.status ?? set.status,
    );
  })
  .onError(({ path, error, code }) => {
    if (error instanceof PayloadTooLargeError) {
      return Response.json(
        { error: "Payload Too Large", message: error.message },
        { status: 413 },
      );
    }
    logger.error("%s\n%s", path, errorToString(error));
    if (code === "INTERNAL_SERVER_ERROR") {
      const message =
        config.env === "development"
          ? errorToString(error)
          : "Something went wrong";
      return new Response(message, { status: 500 });
    }
  })
  // Public: served locally, mirrors the worker surface.
  .use(statusController)
  .get("/cluster/health", () => ({
    instanceId,
    role,
    connectionCount: 0,
    draining: false,
  }))
  // Admin fan-out: a logout-all must reach every worker.
  .group("/admin", (app) =>
    app
      .use(adminGuard)
      .post("/connections/logout-all", ({ request }) =>
        fanOutToAllInstances(request),
      ),
  )
  // Data plane.
  .group("", (app) =>
    app
      .use(authMiddleware)
      .get(
        "/media/:messageId",
        ({ params, request }) => forwardMediaRequest(params.messageId, request),
        {
          params: t.Object({ messageId: t.String() }),
        },
      )
      .all(
        "/connections/:phoneNumber",
        ({ params, request }) => forwardByPhone(params.phoneNumber, request),
        {
          params: t.Object({ phoneNumber: t.String() }),
        },
      )
      .all(
        "/connections/:phoneNumber/*",
        ({ params, request }) => forwardByPhone(params.phoneNumber, request),
        {
          params: t.Object({ phoneNumber: t.String(), "*": t.String() }),
        },
      ),
  );

if (config.env === "development") {
  proxyApp.use(cors());
} else {
  proxyApp.use(cors({ origin: config.corsOrigin }));
}

export default proxyApp;
