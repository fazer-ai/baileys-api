import { heapStats } from "bun:jsc";
import { join } from "node:path";
import { writeHeapSnapshot } from "node:v8";
import logger from "@/lib/logger";

export class HeapAnalyzer {
  private static instance: HeapAnalyzer;
  private snapshotCounter = 0;
  private baselineStats: ReturnType<typeof heapStats> | null = null;

  static getInstance(): HeapAnalyzer {
    if (!HeapAnalyzer.instance) {
      HeapAnalyzer.instance = new HeapAnalyzer();
    }
    return HeapAnalyzer.instance;
  }

  /**
   * Create a heap snapshot for Chrome DevTools analysis
   */
  createSnapshot(name?: string): { filepath: string; filename: string } {
    this.snapshotCounter++;
    const filename = name
      ? `${name}-${this.snapshotCounter}.heapsnapshot`
      : `baileys-api-${Date.now()}-${this.snapshotCounter}.heapsnapshot`;

    const filepath = join(process.cwd(), "heap-snapshots", filename);

    try {
      writeHeapSnapshot(filepath);
      logger.info(`Heap snapshot created: ${filepath}`);
      return { filepath, filename };
    } catch (error) {
      logger.error("Failed to create heap snapshot:", error);
      throw error;
    }
  }

  /**
   * Get detailed JSC heap statistics
   */
  getHeapStats() {
    return heapStats();
  }

  /**
   * Set baseline heap stats for comparison
   */
  setBaseline() {
    this.baselineStats = this.getHeapStats();
    logger.info("Heap baseline set", {
      heapSize: this.baselineStats.heapSize,
      objectCount: this.baselineStats.objectCount,
    });
  }

  /**
   * Compare current heap stats with baseline
   */
  compareWithBaseline(): {
    heapSizeIncrease: number;
    objectCountIncrease: number;
    suspiciousObjectTypes: Record<
      string,
      { current: number; baseline: number; increase: number }
    >;
  } | null {
    if (!this.baselineStats) {
      logger.warn("No baseline set for heap comparison");
      return null;
    }

    const current = this.getHeapStats();
    const comparison = {
      heapSizeIncrease: current.heapSize - this.baselineStats.heapSize,
      objectCountIncrease: current.objectCount - this.baselineStats.objectCount,
      suspiciousObjectTypes: {} as Record<
        string,
        { current: number; baseline: number; increase: number }
      >,
    };

    // Find object types with significant increases
    for (const [type, currentCount] of Object.entries(
      current.objectTypeCounts,
    )) {
      const baselineCount = this.baselineStats.objectTypeCounts[type] || 0;
      const increase = (currentCount as number) - baselineCount;

      // Flag types with >1000 new objects or >10x increase
      if (
        increase > 1000 ||
        (baselineCount > 0 && increase > baselineCount * 10)
      ) {
        comparison.suspiciousObjectTypes[type] = {
          current: currentCount as number,
          baseline: baselineCount,
          increase,
        };
      }
    }

    return comparison;
  }

  /**
   * Analyze potential memory leak patterns
   */
  analyzeLeakPatterns() {
    const stats = this.getHeapStats();
    const patterns = {
      highObjectCounts: {} as Record<string, number>,
      suspiciousPatterns: [] as string[],
      protectedObjectIssues: {} as Record<string, number>,
    };

    // Check for high object counts (potential leaks)
    for (const [type, count] of Object.entries(stats.objectTypeCounts)) {
      if ((count as number) > 10000) {
        patterns.highObjectCounts[type] = count as number;
      }
    }

    // Check for suspicious patterns
    if (stats.objectTypeCounts.Promise > 5000) {
      patterns.suspiciousPatterns.push(
        "High Promise count - potential unresolved promises",
      );
    }

    if (stats.objectTypeCounts.Function > 20000) {
      patterns.suspiciousPatterns.push(
        "High Function count - potential closure leaks",
      );
    }

    if (stats.objectTypeCounts.Object > 50000) {
      patterns.suspiciousPatterns.push(
        "High Object count - potential object accumulation",
      );
    }

    // Check protected objects (timers, etc.)
    for (const [type, count] of Object.entries(
      stats.protectedObjectTypeCounts,
    )) {
      if ((count as number) > 1000) {
        patterns.protectedObjectIssues[type] = count as number;
      }
    }

    return patterns;
  }

  /**
   * Get memory usage in a readable format
   */
  getMemoryUsage() {
    const rss = process.memoryUsage.rss();
    const stats = this.getHeapStats();

    return {
      rss: Math.round(rss / 1024 / 1024), // MB
      heapSize: Math.round(stats.heapSize / 1024 / 1024), // MB
      objectCount: stats.objectCount,
      topObjectTypes: Object.entries(stats.objectTypeCounts)
        .sort(([, a], [, b]) => (b as number) - (a as number))
        .slice(0, 10)
        .reduce(
          (acc, [type, count]) => {
            acc[type] = count;
            return acc;
          },
          {} as Record<string, number>,
        ),
    };
  }
}
