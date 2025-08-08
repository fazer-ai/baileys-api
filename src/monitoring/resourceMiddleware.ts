import logger from "@/lib/logger";

interface ResourceMetrics {
  requestCount: number;
  activeRequests: number;
  memoryBaseline: NodeJS.MemoryUsage;
  lastBaselineUpdate: number;
  lastGC?: number;
}

const metrics: ResourceMetrics = {
  requestCount: 0,
  activeRequests: 0,
  memoryBaseline: process.memoryUsage(),
  lastBaselineUpdate: Date.now(),
};

// Track recent memory measurements for trend analysis
const recentMeasurements: Array<{
  timestamp: number;
  heapUsed: number;
}> = [];

function updateBaselineIfNeeded(currentMemory: NodeJS.MemoryUsage) {
  const now = Date.now();
  const timeSinceBaseline = now - metrics.lastBaselineUpdate;

  const shouldUpdateTime = timeSinceBaseline > 60 * 60 * 1000;

  if (shouldUpdateTime && recentMeasurements.length >= 5) {
    const recent = recentMeasurements.slice(-3);
    const older = recentMeasurements.slice(-6, -3);

    if (recent.length >= 3 && older.length >= 3) {
      const recentAvg =
        recent.reduce((sum, m) => sum + m.heapUsed, 0) / recent.length;
      const olderAvg =
        older.reduce((sum, m) => sum + m.heapUsed, 0) / older.length;

      let trend = "stable";
      if (olderAvg > 0) {
        const change = ((recentAvg - olderAvg) / olderAvg) * 100;
        if (change > 5) trend = "increasing";
        else if (change < -5) trend = "decreasing";
      }

      if (trend === "stable" || trend === "decreasing") {
        const oldBaseline = metrics.memoryBaseline.heapUsed;
        metrics.memoryBaseline = { ...currentMemory };
        metrics.lastBaselineUpdate = now;

        logger.info(
          "Resource baseline updated after %d hours. Old: %d MB, New: %d MB (trend: %s)",
          Math.round(timeSinceBaseline / (1000 * 60 * 60)),
          Math.round(oldBaseline / 1024 / 1024),
          Math.round(currentMemory.heapUsed / 1024 / 1024),
          trend,
        );
      } else {
        logger.debug(
          "Resource baseline update skipped due to %s memory trend",
          trend,
        );
      }
    }
  }
}

export function trackRequest() {
  const startTime = Date.now();
  const requestMemory = process.memoryUsage();

  recentMeasurements.push({
    timestamp: Date.now(),
    heapUsed: requestMemory.heapUsed,
  });

  if (recentMeasurements.length > 10) {
    recentMeasurements.shift();
  }

  metrics.requestCount++;
  metrics.activeRequests++;

  updateBaselineIfNeeded(requestMemory);

  const memoryDiff = requestMemory.heapUsed - metrics.memoryBaseline.heapUsed;
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
    memoryIncrease: current.heapUsed - metrics.memoryBaseline.heapUsed,
    baselineAge: Date.now() - metrics.lastBaselineUpdate,
    gcInfo: {
      rss: current.rss,
      heapTotal: current.heapTotal,
      heapUsed: current.heapUsed,
      external: current.external,
    },
  };
}
