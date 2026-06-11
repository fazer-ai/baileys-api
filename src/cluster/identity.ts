import os from "node:os";
import config from "@/config";

// Stable for the lifetime of the process. Each replica must have a distinct
// id; the random suffix covers restarts of the same container, where a reused
// hostname could otherwise impersonate the leases of the previous run.
export const instanceId =
  config.cluster.instanceId ||
  `${os.hostname()}-${Math.random().toString(36).slice(2, 8)}`;

export const role = config.cluster.role;

// Address other instances (the proxy, mainly) can reach this worker at.
// Container hostnames resolve within a docker network, so the default works
// for compose/Coolify deployments on a shared network.
export const workerBaseUrl =
  config.cluster.workerBaseUrl || `http://${os.hostname()}:${config.port}`;
