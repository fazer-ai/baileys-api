import Elysia from "elysia";
import { adminGuard } from "@/middlewares/auth";
import { MemoryLeakTester } from "@/monitoring/memoryLeakTester";
import {
  compareHeapWithBaseline,
  createHeapSnapshot,
  getHealthReport,
  getHeapStats,
  getMemoryReport,
  setHeapBaseline,
} from "@/monitoring/routes";

const monitoringController = new Elysia({ prefix: "/monitoring" })
  .use(adminGuard)
  .get("/memory", () => getMemoryReport(), {
    detail: {
      tags: ["Monitoring"],
      summary: "Get detailed memory usage report",
      description:
        "Returns memory usage, connection status, and resource metrics",
    },
  })
  .get("/health", () => getHealthReport(), {
    detail: {
      tags: ["Monitoring"],
      summary: "Get system health status",
      description:
        "Returns system health including memory trends and connection status",
    },
  })
  .post(
    "/test-leaks",
    async () => {
      const tester = new MemoryLeakTester();
      try {
        const results = await tester.runAllTests();
        return {
          success: true,
          message: "Memory leak tests completed",
          results,
          note: "Check logs for detailed test output",
        };
      } finally {
        tester.cleanup();
      }
    },
    {
      detail: {
        tags: ["Monitoring"],
        summary: "Run memory leak tests",
        description:
          "Triggers various memory leak scenarios to test monitoring detection",
      },
    },
  )
  .post(
    "/test-leaks/:testType",
    async ({ params }) => {
      const tester = new MemoryLeakTester();
      const { testType } = params;

      try {
        let result: Record<string, unknown>;
        switch (testType) {
          case "event-listeners":
            result = await tester.testEventListenerAccumulation();
            break;
          case "timers":
            result = tester.testTimerLeaks();
            break;
          case "closures":
            result = tester.testClosureLeaks();
            break;
          case "buffers":
            result = tester.testBufferAccumulation();
            break;
          case "webhooks":
            result = await tester.testWebhookPayloadRetention();
            break;
          default:
            return {
              success: false,
              error: `Unknown test type: ${testType}`,
              availableTests: [
                "event-listeners",
                "timers",
                "closures",
                "buffers",
                "webhooks",
              ],
            };
        }

        return {
          success: true,
          testType,
          result,
          note: "Check logs for detailed test output",
        };
      } finally {
        tester.cleanup();
      }
    },
    {
      detail: {
        tags: ["Monitoring"],
        summary: "Run specific memory leak test",
        description: "Triggers a specific memory leak scenario",
      },
    },
  )
  .get("/heap/stats", () => getHeapStats(), {
    detail: {
      tags: ["Monitoring"],
      summary: "Get current heap statistics",
      description: "Returns JSC heap statistics including object type counts",
    },
  })
  .post("/heap/baseline", () => setHeapBaseline(), {
    detail: {
      tags: ["Monitoring"],
      summary: "Set heap baseline for comparison",
      description: "Captures current heap state as baseline for leak detection",
    },
  })
  .get("/heap/compare", () => compareHeapWithBaseline(), {
    detail: {
      tags: ["Monitoring"],
      summary: "Compare current heap with baseline",
      description:
        "Shows heap growth and suspicious object accumulation since baseline",
    },
  })
  .post(
    "/heap/snapshot",
    async ({ set }) => {
      const snapshot = await createHeapSnapshot();

      set.headers["Content-Type"] = "application/octet-stream";
      set.headers["Content-Disposition"] =
        `attachment; filename="${snapshot.filename}"`;

      return Bun.file(snapshot.filepath);
    },
    {
      detail: {
        tags: ["Monitoring"],
        summary: "Create and download V8 heap snapshot",
        description:
          "Generates heap snapshot file and returns it for download to analyze in Chrome DevTools",
      },
    },
  )
  .post("/heap/snapshot/info", async () => createHeapSnapshot(), {
    detail: {
      tags: ["Monitoring"],
      summary: "Create heap snapshot and return file info",
      description:
        "Generates heap snapshot file and returns filepath info without downloading",
    },
  });

export default monitoringController;
