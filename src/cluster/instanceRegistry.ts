import { instanceId, workerBaseUrl } from "@/cluster/identity";
import { clusterKeys } from "@/cluster/keys";
import config from "@/config";
import { errorToString } from "@/helpers/errorToString";
import logger from "@/lib/logger";
import redis from "@/lib/redis";

export interface InstanceInfo {
  instanceId: string;
  baseUrl: string;
  connectionCount: number;
  draining: boolean;
  startedAt: number;
}

const startedAt = Date.now();

// Liveness in the registry is the heartbeat TTL itself: an instance that
// stops heartbeating (crash, SIGKILL, partition) disappears after
// instanceTtlMs and is treated as dead by everyone else.
export async function heartbeat(info: {
  connectionCount: number;
  draining: boolean;
}): Promise<void> {
  const key = clusterKeys.instance(instanceId);
  const payload: InstanceInfo = {
    instanceId,
    baseUrl: workerBaseUrl,
    connectionCount: info.connectionCount,
    draining: info.draining,
    startedAt,
  };
  await redis.set(key, JSON.stringify(payload), {
    expiration: { type: "PX", value: config.cluster.instanceTtlMs },
  });
}

export async function listLiveInstances(): Promise<InstanceInfo[]> {
  const keys = await redis.keys(clusterKeys.instancePattern);
  if (keys.length === 0) {
    return [];
  }
  const values = await Promise.all(keys.map((key) => redis.get(key)));
  const instances: InstanceInfo[] = [];
  for (const value of values) {
    if (!value) {
      continue;
    }
    // One malformed entry must not collapse the whole liveness view — that
    // would distort fair share and trigger avoidable claim churn.
    try {
      instances.push(JSON.parse(value) as InstanceInfo);
    } catch (error) {
      logger.warn(
        "[registry] skipping malformed instance entry %s: %s",
        value,
        errorToString(error),
      );
    }
  }
  return instances;
}

export async function isInstanceAlive(id: string): Promise<boolean> {
  return (await redis.exists(clusterKeys.instance(id))) === 1;
}

export async function deregister(): Promise<void> {
  await redis.del(clusterKeys.instance(instanceId));
}
