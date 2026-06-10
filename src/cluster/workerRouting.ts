import { instanceId } from "@/cluster/identity";
import { isInstanceAlive } from "@/cluster/instanceRegistry";
import { getLease } from "@/cluster/leaseStore";
import config from "@/config";

// Decides whether a request for `phoneNumber` landed on the wrong worker.
// Returns the owning instance id when the request must be re-routed by the
// proxy (HTTP 421), or null when this instance may serve it locally.
//
// Only meaningful in worker role: standalone has nobody to re-route to.
// The lease is consulted even when a local socket exists — during a handoff
// the new owner force-acquires before this instance self-fences, so "has a
// socket" does not imply "owns the phone"; serving from the zombie socket
// would hide the split-brain from the proxy and leave its route cache stale.
// When the lease cannot be read we serve locally — the request will hit the
// regular handling rather than bouncing forever.
export async function resolveMisdirectedRequest(
  phoneNumber: string,
): Promise<string | null> {
  if (config.cluster.role !== "worker") {
    return null;
  }
  try {
    const lease = await getLease(phoneNumber);
    if (
      lease &&
      lease.owner !== instanceId &&
      (await isInstanceAlive(lease.owner))
    ) {
      return lease.owner;
    }
  } catch {
    return null;
  }
  // No lease, our own lease, or a dead owner whose lease has not expired
  // yet: serve locally. Advertising a dead owner would just send the caller
  // to an address that cannot answer; the regular handling (local socket or
  // not-connected) is the honest response while failover claims the phone.
  return null;
}
