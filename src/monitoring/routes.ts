import { ConnectionTracker, getResourceMetrics, MemoryMonitor } from "./index";

export function getMemoryReport() {
  const memoryReport = MemoryMonitor.getInstance().getMemoryReport();
  const resourceMetrics = getResourceMetrics();
  const connectionReport =
    ConnectionTracker.getInstance().getConnectionReport();

  return {
    memory: memoryReport,
    resources: resourceMetrics,
    connections: connectionReport,
    timestamp: new Date().toISOString(),
  };
}

export function getHealthReport() {
  const memoryReport = MemoryMonitor.getInstance().getMemoryReport();
  const connectionReport =
    ConnectionTracker.getInstance().getConnectionReport();
  const resourceMetrics = getResourceMetrics();

  const currentHeapMB = Math.round(memoryReport.current.heapUsed / 1024 / 1024);
  const memoryIncreaseMB = Math.round(
    resourceMetrics.memoryIncrease / 1024 / 1024,
  );

  const health = {
    status: "ok",
    memory: {
      current: `${currentHeapMB} MB`,
      trend: memoryReport.trend,
      increase: `${memoryIncreaseMB} MB`,
    },
    connections: {
      active: connectionReport.totalConnections,
      stale: connectionReport.staleConnections,
    },
    requests: {
      total: resourceMetrics.requestCount,
      active: resourceMetrics.activeRequests,
    },
    timestamp: new Date().toISOString(),
  };

  if (
    memoryReport.trend === "increasing" ||
    connectionReport.staleConnections > 0
  ) {
    health.status = "warning";
  }

  return health;
}
