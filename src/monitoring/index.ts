import logger from "@/lib/logger";
import { ConnectionTracker } from "./connectionTracker";
import { FileSystemMonitor } from "./fileSystemMonitor";
import { MemoryMonitor } from "./memoryMonitor";
import { getResourceMetrics, trackRequest } from "./resourceMiddleware";

let connectionReportIntervalId: ReturnType<typeof setInterval> | null = null;
let memoryTrendIntervalId: ReturnType<typeof setInterval> | null = null;
let isMonitoringStarted = false;

export function startMonitoring() {
  if (isMonitoringStarted) {
    logger.debug(
      "Monitoring already started, skipping duplicate initialization",
    );
    return;
  }

  MemoryMonitor.getInstance().start(30000);

  FileSystemMonitor.getInstance().startMonitoring(60000);

  connectionReportIntervalId = setInterval(() => {
    ConnectionTracker.getInstance().logPeriodicReport();
  }, 120000);

  memoryTrendIntervalId = setInterval(() => {
    const memoryReport = MemoryMonitor.getInstance().getMemoryReport();
    logger.info(
      "Memory trend: %s, Current heap: %d MB",
      memoryReport.trend,
      Math.round(memoryReport.current.heapUsed / 1024 / 1024),
    );
  }, 300000);

  isMonitoringStarted = true;
  logger.info("Memory leak monitoring started");
}

export function stopMonitoring() {
  MemoryMonitor.getInstance().stop();
  FileSystemMonitor.getInstance().stop();

  if (connectionReportIntervalId) {
    clearInterval(connectionReportIntervalId);
    connectionReportIntervalId = null;
  }

  if (memoryTrendIntervalId) {
    clearInterval(memoryTrendIntervalId);
    memoryTrendIntervalId = null;
  }

  isMonitoringStarted = false;
  logger.info("Memory leak monitoring stopped");
}

export {
  MemoryMonitor,
  ConnectionTracker,
  FileSystemMonitor,
  trackRequest,
  getResourceMetrics,
};
