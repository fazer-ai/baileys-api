import logger from "@/lib/logger";

interface ResourceMetrics {
  requestCount: number;
  activeRequests: number;
  memoryAtStart: NodeJS.MemoryUsage;
  lastGC?: number;
}

const metrics: ResourceMetrics = {
  requestCount: 0,
  activeRequests: 0,
  memoryAtStart: process.memoryUsage(),
};

export function trackRequest() {
  const startTime = Date.now();
  const requestMemory = process.memoryUsage();

  metrics.requestCount++;
  metrics.activeRequests++;

  const memoryDiff = requestMemory.heapUsed - metrics.memoryAtStart.heapUsed;
  if (memoryDiff > 50 * 1024 * 1024) {
    logger.warn(
      "High memory usage detected: +%d MB",
      Math.round(memoryDiff / 1024 / 1024),
    );
  }

  return {
    end: () => {
      metrics.activeRequests--;

      const duration = Date.now() - startTime;
      const endMemory = process.memoryUsage();
      const memoryIncrease = endMemory.heapUsed - requestMemory.heapUsed;

      if (memoryIncrease > 10 * 1024 * 1024) {
        logger.warn(
          "Request caused memory increase: +%d MB (%d ms)",
          Math.round(memoryIncrease / 1024 / 1024),
          duration,
        );
      }
    },
  };
}

export function getResourceMetrics() {
  const current = process.memoryUsage();
  return {
    ...metrics,
    currentMemory: current,
    memoryIncrease: current.heapUsed - metrics.memoryAtStart.heapUsed,
    gcInfo: {
      rss: current.rss,
      heapTotal: current.heapTotal,
      heapUsed: current.heapUsed,
      external: current.external,
    },
  };
}
