import {
  getInstance,
  type InstanceInfo,
  listLiveInstances,
} from "@/cluster/instanceRegistry";
import { mediaOwnerKey } from "@/cluster/keys";
import { getLease } from "@/cluster/leaseStore";
import { errorToString } from "@/helpers/errorToString";
import logger from "@/lib/logger";
import redis from "@/lib/redis";
import {
  type ForwardableRequest,
  forwardRequest,
  toForwardable,
} from "@/proxy/forward";
import {
  getCachedTarget,
  invalidateTarget,
  type RouteTarget,
  setCachedTarget,
} from "@/proxy/routeCache";

export type PhoneResolution =
  | { status: "owned"; target: RouteTarget }
  | { status: "owner-dead"; ownerInstanceId: string }
  | { status: "unowned" };

export async function resolvePhoneTarget(
  phoneNumber: string,
): Promise<PhoneResolution> {
  const cached = getCachedTarget(phoneNumber);
  if (cached) {
    return { status: "owned", target: cached };
  }

  const lease = await getLease(phoneNumber);
  if (!lease) {
    return { status: "unowned" };
  }

  const instance = await getInstance(lease.owner);
  if (!instance) {
    // Lease still alive but the owner stopped heartbeating: it crashed and
    // the failover (lease TTL + claim loop) hasn't completed yet.
    return { status: "owner-dead", ownerInstanceId: lease.owner };
  }

  const target = { instanceId: lease.owner, baseUrl: instance.baseUrl };
  setCachedTarget(phoneNumber, target);
  return { status: "owned", target };
}

export async function pickLeastLoadedWorker(): Promise<RouteTarget | null> {
  const instances = await listLiveInstances();
  const eligible = instances.filter((instance) => !instance.draining);
  if (eligible.length === 0) {
    return null;
  }
  const least = eligible.reduce((best, candidate) =>
    candidate.connectionCount < best.connectionCount ? candidate : best,
  );
  return { instanceId: least.instanceId, baseUrl: least.baseUrl };
}

function serviceUnavailable(): Response {
  // The lease TTL bounds how long until a surviving worker claims the phone;
  // the client's retry policy rides on retry-after.
  return Response.json(
    {
      error: "Service Unavailable",
      message: "Connection owner is down, failover in progress",
    },
    { status: 503, headers: { "retry-after": "5" } },
  );
}

function notFound(message: string): Response {
  return Response.json({ error: "Not Found", message }, { status: 404 });
}

async function sendToTarget(
  target: RouteTarget,
  request: ForwardableRequest,
  phoneNumber?: string,
): Promise<Response> {
  try {
    return await forwardRequest(target.baseUrl, request);
  } catch (error) {
    logger.warn(
      "[proxy] forward to %s (%s) failed: %s",
      target.instanceId,
      target.baseUrl,
      errorToString(error),
    );
    if (phoneNumber) {
      invalidateTarget(phoneNumber);
    }
    // Distinguish "worker died" (failover will fix it; tell the client to
    // retry shortly) from "worker is up but slow/wedged" (gateway timeout).
    const stillRegistered = await getInstance(target.instanceId).catch(
      () => null,
    );
    if (!stillRegistered) {
      return serviceUnavailable();
    }
    return Response.json(
      { error: "Gateway Timeout", message: "Connection owner did not respond" },
      { status: 504 },
    );
  }
}

// Routes a /connections/:phone request to the owning worker.
// - No owner: POST /connections/:phone is a new-connection placement (least
//   loaded worker decides ownership by acquiring the lease itself); anything
//   else is 404, matching single-instance not-connected behavior.
// - 421/409 from the worker means our route was stale (or placement raced):
//   invalidate, re-resolve via the owner the worker pointed at, re-send ONCE.
export async function forwardByPhone(
  phoneNumber: string,
  rawRequest: Request,
): Promise<Response> {
  const isConnectPost =
    rawRequest.method === "POST" &&
    decodeURIComponent(new URL(rawRequest.url).pathname) ===
      `/connections/${phoneNumber}`;

  const resolution = await resolvePhoneTarget(phoneNumber);

  if (resolution.status === "owner-dead") {
    invalidateTarget(phoneNumber);
    return serviceUnavailable();
  }

  let target: RouteTarget | null = null;
  if (resolution.status === "owned") {
    target = resolution.target;
  } else if (isConnectPost) {
    target = await pickLeastLoadedWorker();
    if (!target) {
      return Response.json(
        {
          error: "Service Unavailable",
          message: "No live workers available",
        },
        { status: 503, headers: { "retry-after": "5" } },
      );
    }
  } else {
    return notFound("Phone number not connected");
  }

  // Buffer only after routing succeeds: a request bound for a 404/503 must
  // not have its body read (or rejected with 413) first.
  const request = await toForwardable(rawRequest);
  const response = await sendToTarget(target, request, phoneNumber);
  if (response.status !== 421 && response.status !== 409) {
    return response;
  }

  invalidateTarget(phoneNumber);
  const owner = response.headers.get("x-baileys-owner");
  if (!owner) {
    // No owner to retry against: relay the worker's 421/409 as-is. The body
    // is delivered to the client, so it must NOT be cancelled here.
    return response;
  }
  // The misdirection response is dropped in favor of the retry; discard its
  // unread body so the connection is released back to the pool.
  await response.body?.cancel().catch(() => {});
  const ownerInstance = await getInstance(owner).catch(() => null);
  if (!ownerInstance) {
    return serviceUnavailable();
  }
  const retryTarget = {
    instanceId: owner,
    baseUrl: ownerInstance.baseUrl,
  };
  const retried = await sendToTarget(retryTarget, request, phoneNumber);
  if (retried.status === 421 || retried.status === 409) {
    // Two hops and still misdirected — ownership is in flux (failover or
    // rebalance mid-flight). Let the client retry rather than loop here.
    await retried.body?.cancel().catch(() => {});
    return serviceUnavailable();
  }
  if (retried.ok) {
    setCachedTarget(phoneNumber, retryTarget);
  }
  return retried;
}

export async function forwardMediaRequest(
  messageId: string,
  rawRequest: Request,
): Promise<Response> {
  const ownerId = await redis.get(mediaOwnerKey(messageId));
  if (!ownerId) {
    return notFound("File not found");
  }
  const instance = await getInstance(ownerId);
  if (!instance) {
    // The file lived on a dead instance's local disk — it is gone.
    return notFound("File not found");
  }
  const request = await toForwardable(rawRequest);
  try {
    return await forwardRequest(instance.baseUrl, request);
  } catch (error) {
    logger.warn(
      "[proxy] media forward to %s (%s) failed: %s",
      ownerId,
      instance.baseUrl,
      errorToString(error),
    );
    // Same dead-vs-slow split as sendToTarget, except a dead owner here
    // means the file is gone with its disk — a final 404, not a retryable
    // 503.
    const stillRegistered = await getInstance(ownerId).catch(() => null);
    if (!stillRegistered) {
      return notFound("File not found");
    }
    return Response.json(
      { error: "Gateway Timeout", message: "Media owner did not respond" },
      { status: 504 },
    );
  }
}

export async function fanOutToAllInstances(
  rawRequest: Request,
): Promise<Response> {
  const instances = await listLiveInstances();
  // Buffered after listing for the same reason as forwardByPhone: an empty
  // worker pool should not cost a body read (nor a 413).
  if (instances.length === 0) {
    return Response.json({ results: [] });
  }
  const request = await toForwardable(rawRequest);
  const results = await Promise.allSettled(
    instances.map(async (instance: InstanceInfo) => {
      const response = await forwardRequest(instance.baseUrl, request);
      const status = response.status;
      // Only the status is aggregated; discard the unread body to release
      // the pooled connection.
      await response.body?.cancel().catch(() => {});
      return { instanceId: instance.instanceId, status };
    }),
  );
  return Response.json({
    results: results.map((result, i) =>
      result.status === "fulfilled"
        ? result.value
        : {
            instanceId: instances[i].instanceId,
            error: errorToString(result.reason),
          },
    ),
  });
}
