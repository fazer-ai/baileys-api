import Elysia from "elysia";
import baileys from "@/baileys";
import coordinator from "@/cluster";
import { instanceId, role } from "@/cluster/identity";

// Unauthenticated by design: consumed by container healthchecks and the
// proxy's liveness probing. Exposes no secrets — counts and identifiers only.
const clusterController = new Elysia({
  prefix: "/cluster",
  detail: {
    tags: ["Cluster"],
  },
}).get(
  "/health",
  () => ({
    instanceId,
    role,
    connectionCount: baileys.size,
    draining: coordinator.isDraining,
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
