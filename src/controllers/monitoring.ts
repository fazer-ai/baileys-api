import Elysia from "elysia";
import { MemoryLeakTester } from "@/monitoring/memoryLeakTester";
import { getHealthReport, getMemoryReport } from "@/monitoring/routes";

const monitoringController = new Elysia({ prefix: "/monitoring" })
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
  );

export default monitoringController;
