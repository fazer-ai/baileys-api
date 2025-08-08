import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import logger from "@/lib/logger";

export class FileSystemMonitor {
  private static instance: FileSystemMonitor;
  private intervalId: NodeJS.Timer | null = null;

  static getInstance(): FileSystemMonitor {
    if (!FileSystemMonitor.instance) {
      FileSystemMonitor.instance = new FileSystemMonitor();
    }
    return FileSystemMonitor.instance;
  }

  startMonitoring(intervalMs = 60000) {
    if (this.intervalId) return;

    this.intervalId = setInterval(async () => {
      await this.checkMediaDirectory();
    }, intervalMs);

    this.checkMediaDirectory();
  }

  private async checkMediaDirectory() {
    try {
      const mediaDir = "media";
      const files = await readdir(mediaDir);

      let totalSize = 0;
      let oldFiles = 0;
      const now = Date.now();
      const oneDayAgo = now - 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (file === ".keep") continue;

        const filePath = join(mediaDir, file);
        const stats = await stat(filePath);
        totalSize += stats.size;

        if (stats.mtime.getTime() < oneDayAgo) {
          oldFiles++;
        }
      }

      const totalSizeMB = Math.round(totalSize / 1024 / 1024);

      logger.debug(
        "Media directory: %d files, %d MB total, %d files >24h old",
        files.length - 1,
        totalSizeMB,
        oldFiles,
      );
    } catch (error) {
      logger.error("Error monitoring media directory: %s", error);
    }
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}
