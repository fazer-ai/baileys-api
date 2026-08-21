import Elysia from "elysia";
import baileys from "@/baileys";
import coordinator from "@/cluster";
import { instanceId, role } from "@/cluster/identity";

export interface ClusterHealthResponse {
  instanceId: string;
  role: string;
  connectionCount: number;
  draining: boolean;
  // Connections that are registered and receiving but whose sends are wedged.
  // NOTE: For alerting only. This must never make the container health check
  // fail — a failing check restarts the process and takes every healthy
  // connection down with it, which is strictly worse than the stall.
  stalledConnectionCount: number;
}

// Unauthenticated by design: consumed by container healthchecks and the
// proxy's liveness probing. Exposes no secrets — counts and identifiers only.
const clusterController = new Elysia({
  prefix: "/cluster",
  detail: {
    tags: ["Cluster"],
  },
}).get(
  "/health",
  (): ClusterHealthResponse => ({
    instanceId,
    role,
    connectionCount: baileys.size,
    draining: coordinator.isDraining,
    stalledConnectionCount: baileys.stalledConnectionCount(),
  }),
  {
    detail: {
      responses: {
        200: {
          description: "Instance health and cluster identity",
        },
      },
    },
  },
);

export default clusterController;
