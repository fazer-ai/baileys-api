import { instanceId } from "@/cluster/identity";
import { getLease } from "@/cluster/leaseStore";
import config from "@/config";

// Decides whether a request for `phoneNumber` landed on the wrong worker.
// Returns the owning instance id when the request must be re-routed by the
// proxy (HTTP 421), or null when this instance may serve it locally.
//
// Only meaningful in worker role: standalone has nobody to re-route to, and
// a local connection always wins (the lease and the socket live together).
// When the lease cannot be read we also serve locally — the request will hit
// the regular not-connected handling rather than bouncing forever.
export async function resolveMisdirectedRequest(
  phoneNumber: string,
  hasLocalConnection: boolean,
): Promise<string | null> {
  if (config.cluster.role !== "worker" || hasLocalConnection) {
    return null;
  }
  try {
    const lease = await getLease(phoneNumber);
    if (lease && lease.owner !== instanceId) {
      return lease.owner;
    }
  } catch {
    return null;
  }
  return null;
}
