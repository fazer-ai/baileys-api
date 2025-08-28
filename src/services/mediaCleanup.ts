import { promises as fs } from "node:fs";
import path from "node:path";
import { errorToString } from "@/helpers/errorToString";
import logger from "@/lib/logger";

export class MediaCleanupService {
  private cleanupInterval: NodeJS.Timer | null = null;
  private readonly mediaDir = path.resolve(process.cwd(), "media");
  private readonly maxAgeMs: number;
  private readonly intervalMs: number;

  constructor({
    maxAgeHours = 24,
    intervalMs = 60 * 60 * 1000,
  }: { maxAgeHours: number; intervalMs: number }) {
    this.maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    this.intervalMs = intervalMs;
  }

  start() {
    if (this.cleanupInterval) {
      logger.warn("Media cleanup service is already running");
      return;
    }

    logger.info(
      "Starting media cleanup service (interval: %dms, maxAge: %dh)",
      this.intervalMs,
      this.maxAgeMs / (60 * 60 * 1000),
    );

    this.cleanupInterval = setInterval(() => {
      this.cleanup().catch((error) => {
        logger.error("Media cleanup failed: %s", errorToString(error));
      });
    }, this.intervalMs);

    this.cleanup().catch((error) => {
      logger.error("Initial media cleanup failed: %s", errorToString(error));
    });
  }

  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      logger.info("Media cleanup service stopped");
    }
  }

  async cleanup(): Promise<void> {
    try {
      const files = await fs.readdir(this.mediaDir);
      const now = Date.now();
      let deletedCount = 0;
      let totalSize = 0;

      for (const filename of files) {
        if (filename.startsWith(".")) {
          continue;
        }

        const filePath = path.join(this.mediaDir, filename);
        try {
          const stats = await fs.stat(filePath);
          if (!stats.isFile()) {
            continue;
          }

          const fileAge = now - stats.mtime.getTime();
          if (fileAge > this.maxAgeMs) {
            await fs.unlink(filePath);
            deletedCount++;
            totalSize += stats.size;
            logger.debug(
              "Deleted old media file: %s (age: %dh)",
              filename,
              fileAge / (60 * 60 * 1000),
            );
          }
        } catch (fileError) {
          logger.warn(
            "Failed to process file %s: %s",
            filename,
            errorToString(fileError),
          );
        }
      }

      if (deletedCount > 0) {
        logger.info(
          "Cleaned up %d old media files (freed %s)",
          deletedCount,
          this.formatBytes(totalSize),
        );
      } else {
        logger.debug("No old media files to clean up");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        logger.debug("Media directory does not exist yet, skipping cleanup");
        return;
      }
      throw error;
    }
  }

  private formatBytes(bytes: number): string {
    if (!bytes) {
      return "0 Bytes";
    }

    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${Number.parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
  }

  getStatus() {
    return {
      isRunning: this.cleanupInterval !== null,
      intervalMs: this.intervalMs,
      maxAgeHours: this.maxAgeMs / (60 * 60 * 1000),
      mediaDirectory: this.mediaDir,
    };
  }
}
