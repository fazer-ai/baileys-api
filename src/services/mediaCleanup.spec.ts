import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { promises as fs } from "node:fs";
import { MediaCleanupService } from "./mediaCleanup";

// Logger is mocked in preload.ts

describe("MediaCleanupService", () => {
  let service: MediaCleanupService;

  beforeEach(() => {
    service = new MediaCleanupService({
      maxAgeHours: 1,
      intervalMs: 60_000,
    });
  });

  afterEach(() => {
    service.stop();
    mock.restore();
  });

  describe("constructor", () => {
    it("sets maxAgeMs from maxAgeHours", () => {
      const status = service.getStatus();
      expect(status.maxAgeHours).toBe(1);
    });

    it("sets intervalMs", () => {
      const status = service.getStatus();
      expect(status.intervalMs).toBe(60_000);
    });

    it("uses default values when not provided", () => {
      const defaultService = new MediaCleanupService({});
      const status = defaultService.getStatus();
      expect(status.maxAgeHours).toBe(24);
      expect(status.intervalMs).toBe(60 * 60 * 1000);
      defaultService.stop();
    });
  });

  describe("getStatus", () => {
    it("reports not running before start", () => {
      expect(service.getStatus().isRunning).toBe(false);
    });

    it("reports running after start", () => {
      spyOn(fs, "readdir").mockResolvedValue([] as any);
      service.start();
      expect(service.getStatus().isRunning).toBe(true);
    });

    it("reports not running after stop", () => {
      spyOn(fs, "readdir").mockResolvedValue([] as any);
      service.start();
      service.stop();
      expect(service.getStatus().isRunning).toBe(false);
    });
  });

  describe("start", () => {
    it("does not start a second interval if already running", () => {
      spyOn(fs, "readdir").mockResolvedValue([] as any);
      service.start();
      // Calling start again should be a no-op
      service.start();
      expect(service.getStatus().isRunning).toBe(true);
    });
  });

  describe("cleanup", () => {
    it("handles non-existent media directory gracefully", async () => {
      const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      spyOn(fs, "readdir").mockRejectedValue(enoent);

      // Should not throw
      await service.cleanup();
    });

    it("rethrows non-ENOENT errors", async () => {
      spyOn(fs, "readdir").mockRejectedValue(new Error("permission denied"));
      expect(service.cleanup()).rejects.toThrow("permission denied");
    });

    it("deletes files older than maxAge", async () => {
      const now = Date.now();
      const oldMtime = new Date(now - 2 * 60 * 60 * 1000); // 2 hours ago

      spyOn(fs, "readdir").mockResolvedValue([
        { name: "old-file", isFile: () => true },
      ] as any);

      spyOn(fs, "stat").mockResolvedValue({
        isFile: () => true,
        mtime: oldMtime,
        size: 1024,
      } as any);

      const unlinkSpy = spyOn(fs, "unlink").mockResolvedValue(undefined);

      await service.cleanup();

      expect(unlinkSpy).toHaveBeenCalledTimes(1);
    });

    it("does not delete files newer than maxAge", async () => {
      spyOn(fs, "readdir").mockResolvedValue([
        { name: "new-file", isFile: () => true },
      ] as any);

      spyOn(fs, "stat").mockResolvedValue({
        isFile: () => true,
        mtime: new Date(), // just now
        size: 512,
      } as any);

      const unlinkSpy = spyOn(fs, "unlink").mockResolvedValue(undefined);

      await service.cleanup();

      expect(unlinkSpy).not.toHaveBeenCalled();
    });

    it("skips hidden files (starting with .)", async () => {
      spyOn(fs, "readdir").mockResolvedValue([
        { name: ".gitkeep", isFile: () => true },
      ] as any);

      const statSpy = spyOn(fs, "stat").mockResolvedValue({} as any);

      await service.cleanup();

      expect(statSpy).not.toHaveBeenCalled();
    });

    it("skips non-file entries", async () => {
      spyOn(fs, "readdir").mockResolvedValue([
        { name: "subdir", isFile: () => false },
      ] as any);

      const statSpy = spyOn(fs, "stat").mockResolvedValue({} as any);

      await service.cleanup();

      expect(statSpy).not.toHaveBeenCalled();
    });

    it("does not run concurrently", async () => {
      let resolveReaddir!: (value: any) => void;
      spyOn(fs, "readdir").mockImplementation(
        (() =>
          new Promise((resolve) => {
            resolveReaddir = resolve;
          })) as never,
      );

      const first = service.cleanup();
      const second = service.cleanup(); // should return immediately

      // Resolve the first call
      resolveReaddir([]);

      await first;
      await second;
      // If no error, concurrency guard works
    });

    it("handles errors for individual files without stopping", async () => {
      const now = Date.now();
      const oldMtime = new Date(now - 2 * 60 * 60 * 1000);

      spyOn(fs, "readdir").mockResolvedValue([
        { name: "file1", isFile: () => true },
        { name: "file2", isFile: () => true },
      ] as any);

      let callCount = 0;
      spyOn(fs, "stat").mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error("stat error");
        }
        return {
          isFile: () => true,
          mtime: oldMtime,
          size: 100,
        } as any;
      });

      const unlinkSpy = spyOn(fs, "unlink").mockResolvedValue(undefined);

      await service.cleanup(); // should not throw

      // Second file should still be deleted
      expect(unlinkSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("formatBytes (via cleanup logging)", () => {
    it("formats 0 bytes correctly", () => {
      // Access the private method via prototype for coverage
      const formatBytes = (service as any).formatBytes.bind(service);
      expect(formatBytes(0)).toBe("0 Bytes");
    });

    it("formats bytes", () => {
      const formatBytes = (service as any).formatBytes.bind(service);
      expect(formatBytes(500)).toBe("500 Bytes");
    });

    it("formats kilobytes", () => {
      const formatBytes = (service as any).formatBytes.bind(service);
      expect(formatBytes(1024)).toBe("1 KB");
    });

    it("formats megabytes", () => {
      const formatBytes = (service as any).formatBytes.bind(service);
      expect(formatBytes(1024 * 1024)).toBe("1 MB");
    });

    it("formats gigabytes", () => {
      const formatBytes = (service as any).formatBytes.bind(service);
      expect(formatBytes(1024 * 1024 * 1024)).toBe("1 GB");
    });
  });
});
