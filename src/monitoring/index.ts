import logger from "@/lib/logger";
import { ConnectionTracker } from "./connectionTracker";
import { FileSystemMonitor } from "./fileSystemMonitor";
import { MemoryMonitor } from "./memoryMonitor";
import { getResourceMetrics, trackRequest } from "./resourceMiddleware";

export function startMonitoring() {
  MemoryMonitor.getInstance().start(30000);

  FileSystemMonitor.getInstance().startMonitoring(60000);

  setInterval(() => {
    ConnectionTracker.getInstance().logPeriodicReport();
  }, 120000);

  setInterval(() => {
    const memoryReport = MemoryMonitor.getInstance().getMemoryReport();
    logger.info(
      "Memory trend: %s, Current heap: %d MB",
      memoryReport.trend,
      Math.round(memoryReport.current.heapUsed / 1024 / 1024),
    );
  }, 300000);

  logger.info("Memory leak monitoring started");
}

export function stopMonitoring() {
  MemoryMonitor.getInstance().stop();
  FileSystemMonitor.getInstance().stop();
  logger.info("Memory leak monitoring stopped");
}

export {
  MemoryMonitor,
  ConnectionTracker,
  FileSystemMonitor,
  trackRequest,
  getResourceMetrics,
};
