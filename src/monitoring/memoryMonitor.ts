import logger from "@/lib/logger";

export class MemoryMonitor {
  private static instance: MemoryMonitor;
  private intervalId: NodeJS.Timer | null = null;
  private baselineMemory: NodeJS.MemoryUsage | null = null;
  private measurements: Array<{
    timestamp: number;
    memory: NodeJS.MemoryUsage;
  }> = [];

  static getInstance(): MemoryMonitor {
    if (!MemoryMonitor.instance) {
      MemoryMonitor.instance = new MemoryMonitor();
    }
    return MemoryMonitor.instance;
  }

  start(intervalMs = 30000) {
    if (this.intervalId) return;

    this.baselineMemory = process.memoryUsage();
    logger.info("Memory monitoring started. Baseline: %o", this.baselineMemory);

    this.intervalId = setInterval(() => {
      const currentMemory = process.memoryUsage();
      this.measurements.push({
        timestamp: Date.now(),
        memory: currentMemory,
      });

      if (this.measurements.length > 100) {
        this.measurements.shift();
      }

      this.analyzeMemoryTrend(currentMemory);
    }, intervalMs);
  }

  private analyzeMemoryTrend(current: NodeJS.MemoryUsage) {
    if (!this.baselineMemory || this.measurements.length < 5) return;

    const heapIncrease = current.heapUsed - this.baselineMemory.heapUsed;
    const heapIncreasePercent =
      (heapIncrease / this.baselineMemory.heapUsed) * 100;

    if (heapIncreasePercent > 50) {
      logger.warn(
        "Significant heap increase detected: %d MB (+%d%%)",
        Math.round(heapIncrease / 1024 / 1024),
        Math.round(heapIncreasePercent),
      );
    }

    const recentMeasurements = this.measurements.slice(-5);
    const isGrowing = recentMeasurements.every((measurement, index) => {
      return (
        index === 0 ||
        measurement.memory.heapUsed >=
          recentMeasurements[index - 1].memory.heapUsed
      );
    });

    if (isGrowing && recentMeasurements.length === 5) {
      const growthRate =
        recentMeasurements[4].memory.heapUsed -
        recentMeasurements[0].memory.heapUsed;
      logger.warn(
        "Continuous memory growth detected: %d MB over last 5 measurements",
        Math.round(growthRate / 1024 / 1024),
      );
    }
  }

  getMemoryReport() {
    const current = process.memoryUsage();
    return {
      current,
      baseline: this.baselineMemory,
      measurements: this.measurements.slice(-10),
      trend: this.calculateTrend(),
    };
  }

  private calculateTrend() {
    if (this.measurements.length < 2) return "insufficient_data";

    const recent = this.measurements.slice(-5);
    const older = this.measurements.slice(-10, -5);

    if (recent.length === 0 || older.length === 0) return "insufficient_data";

    const recentAvg =
      recent.reduce((sum, m) => sum + m.memory.heapUsed, 0) / recent.length;
    const olderAvg =
      older.reduce((sum, m) => sum + m.memory.heapUsed, 0) / older.length;

    const change = ((recentAvg - olderAvg) / olderAvg) * 100;

    if (change > 10) return "increasing";
    if (change < -10) return "decreasing";
    return "stable";
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}
