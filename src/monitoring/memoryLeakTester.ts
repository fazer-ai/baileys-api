import logger from "@/lib/logger";
import { ConnectionTracker, MemoryMonitor } from "@/monitoring";

export class MemoryLeakTester {
  private testIntervals: NodeJS.Timer[] = [];

  /**
   * Test Theory 1: Event Listener Accumulation
   * Simulate creating multiple connections rapidly without proper cleanup
   */
  async testEventListenerAccumulation() {
    logger.warn(
      "🧪 TESTING: Event Listener Accumulation - Creating/destroying connections rapidly",
    );

    const initialMemory = process.memoryUsage();

    // Simulate rapid connection creation/destruction cycles
    for (let i = 0; i < 50; i++) {
      const phoneNumber = `test_${Date.now()}_${i}`;

      // Simulate connection tracking without proper cleanup
      ConnectionTracker.getInstance().trackConnection(phoneNumber);

      // Simulate some activity
      await new Promise((resolve) => setTimeout(resolve, 10));
      ConnectionTracker.getInstance().updateActivity(phoneNumber);

      // Only clean up every 3rd connection (simulate leak)
      if (i % 3 === 0) {
        ConnectionTracker.getInstance().removeConnection(phoneNumber);
      }
    }

    const afterMemory = process.memoryUsage();
    const memoryIncrease = afterMemory.heapUsed - initialMemory.heapUsed;

    logger.warn("📊 Event Listener Test Results:");
    logger.warn(`  Memory increase: ${Math.round(memoryIncrease / 1024)} KB`);
    logger.warn(
      `  Connection report: ${JSON.stringify(ConnectionTracker.getInstance().getConnectionReport())}`,
    );

    return {
      memoryIncrease,
      connectionReport: ConnectionTracker.getInstance().getConnectionReport(),
    };
  }

  /**
   * Test Theory 2: Timer/Interval Leaks
   * Create multiple timers without proper cleanup
   */
  testTimerLeaks() {
    logger.warn("🧪 TESTING: Timer Leaks - Creating intervals without cleanup");

    const initialMemory = process.memoryUsage();

    // Create multiple intervals (simulating the clearOnlinePresenceTimeout scenario)
    for (let i = 0; i < 20; i++) {
      const interval = setInterval(() => {
        // Simulate some work that might hold references
        new Array(1000).fill(`timer_data_${i}_${Date.now()}`);
        // Don't actually use the data, just create it
      }, 100);

      this.testIntervals.push(interval);

      // Only clear some intervals (simulate leak)
      if (i % 4 === 0) {
        clearInterval(interval);
        const index = this.testIntervals.indexOf(interval);
        if (index > -1) {
          this.testIntervals.splice(index, 1);
        }
      }
    }

    const afterMemory = process.memoryUsage();
    const memoryIncrease = afterMemory.heapUsed - initialMemory.heapUsed;

    logger.warn("📊 Timer Test Results:");
    logger.warn(`  Memory increase: ${Math.round(memoryIncrease / 1024)} KB`);
    logger.warn(`  Active intervals: ${this.testIntervals.length}`);

    return {
      memoryIncrease,
      activeTimers: this.testIntervals.length,
    };
  }

  /**
   * Test Theory 3: Closure/Callback Reference Leaks
   * Create closures that hold references to large objects
   */
  testClosureLeaks() {
    logger.warn(
      "🧪 TESTING: Closure Leaks - Creating callbacks with large object references",
    );

    const initialMemory = process.memoryUsage();
    const callbacks: (() => number)[] = [];

    for (let i = 0; i < 30; i++) {
      // Create a large object
      const largeObject = {
        id: i,
        data: new Array(10000).fill(`large_data_${i}`),
        timestamp: Date.now(),
      };

      // Create a closure that holds reference to the large object
      const callback = () => {
        // This callback holds a reference to largeObject
        return largeObject.data.length;
      };

      callbacks.push(callback);

      // Simulate some callbacks being "cleaned up" but not all
      if (i % 5 === 0) {
        callbacks.shift(); // Remove first callback
      }
    }

    const afterMemory = process.memoryUsage();
    const memoryIncrease = afterMemory.heapUsed - initialMemory.heapUsed;

    logger.warn("📊 Closure Test Results:");
    logger.warn(`  Memory increase: ${Math.round(memoryIncrease / 1024)} KB`);
    logger.warn(`  Retained callbacks: ${callbacks.length}`);

    return {
      memoryIncrease,
      retainedCallbacks: callbacks.length,
      // Keep reference to test retained memory
      _callbacks: callbacks,
    };
  }

  /**
   * Test Theory 4: Large Object Buffer Accumulation
   * Simulate audio/media processing that creates large buffers
   */
  testBufferAccumulation() {
    logger.warn(
      "🧪 TESTING: Buffer Accumulation - Creating large buffers without cleanup",
    );

    const initialMemory = process.memoryUsage();
    const buffers: Buffer[] = [];

    for (let i = 0; i < 20; i++) {
      // Simulate audio processing buffers (like in sendMessage audio preprocessing)
      const audioBuffer = Buffer.alloc(1024 * 1024); // 1MB buffer
      const waveformBuffer = Buffer.alloc(512 * 1024); // 512KB buffer

      // Fill with some data
      audioBuffer.fill(i);
      waveformBuffer.fill(i + 100);

      buffers.push(audioBuffer, waveformBuffer);

      // Simulate partial cleanup
      if (i % 6 === 0 && buffers.length > 5) {
        buffers.splice(0, 2); // Remove 2 oldest buffers
      }
    }

    const afterMemory = process.memoryUsage();
    const memoryIncrease = afterMemory.heapUsed - initialMemory.heapUsed;

    logger.warn("📊 Buffer Test Results:");
    logger.warn(`  Memory increase: ${Math.round(memoryIncrease / 1024)} KB`);
    logger.warn(`  Retained buffers: ${buffers.length}`);
    logger.warn(
      `  Buffer total size: ${Math.round(buffers.reduce((sum, buf) => sum + buf.length, 0) / 1024)} KB`,
    );

    return {
      memoryIncrease,
      buffersStored: buffers.length,
      bufferTotalSize: buffers.reduce((sum, buf) => sum + buf.length, 0),
      // Keep reference to test retained memory (but don't serialize the actual buffers)
      _buffersCount: buffers.length,
    };
  }

  /**
   * Test Theory 5: Webhook Payload Retention
   * Simulate webhook retries holding large payload references
   */
  async testWebhookPayloadRetention() {
    logger.warn(
      "🧪 TESTING: Webhook Payload Retention - Simulating retry queues with large payloads",
    );

    const initialMemory = process.memoryUsage();
    const retryQueues: Array<{
      payload: Record<string, unknown>;
      retries: number;
      nextRetry: number;
    }> = [];

    for (let i = 0; i < 15; i++) {
      // Simulate large webhook payload (like media messages)
      const largePayload = {
        event: "messages.upsert",
        data: {
          messages: [
            {
              key: { id: `msg_${i}` },
              message: {
                imageMessage: {
                  caption: `Large image ${i}`,
                  // Simulate large binary data
                  jpegThumbnail: Buffer.alloc(100 * 1024), // 100KB thumbnail
                },
              },
            },
          ],
          metadata: new Array(1000).fill(`metadata_${i}`),
        },
        extra: {
          media: Buffer.alloc(2 * 1024 * 1024), // 2MB "media" data
          retryCount: 0,
          timestamp: Date.now(),
        },
      };

      // Simulate webhook retry queue holding references
      retryQueues.push({
        payload: largePayload,
        retries: Math.floor(Math.random() * 3),
        nextRetry: Date.now() + 5000,
      });

      // Simulate some successful sends (cleanup)
      if (i % 4 === 0 && retryQueues.length > 2) {
        retryQueues.shift(); // Remove oldest
      }
    }

    const afterMemory = process.memoryUsage();
    const memoryIncrease = afterMemory.heapUsed - initialMemory.heapUsed;

    logger.warn("📊 Webhook Test Results:");
    logger.warn(`  Memory increase: ${Math.round(memoryIncrease / 1024)} KB`);
    logger.warn(`  Retained payloads: ${retryQueues.length}`);

    return {
      memoryIncrease,
      retainedPayloads: retryQueues.length,
      // Keep reference to test retained memory (but don't serialize the actual payloads)
      _retryQueueCount: retryQueues.length,
    };
  }

  /**
   * Clean up test resources
   */
  cleanup() {
    logger.warn(
      "🧹 CLEANUP: Clearing test intervals and forcing garbage collection",
    );

    // Clear all test intervals
    this.testIntervals.forEach((interval) => clearInterval(interval));
    this.testIntervals = [];

    // Force garbage collection if available
    if (global.gc) {
      global.gc();
      logger.warn("🗑️  Forced garbage collection");
    } else {
      logger.warn("ℹ️  Garbage collection not available (run with --expose-gc)");
    }
  }

  /**
   * Run all tests in sequence
   */
  async runAllTests() {
    logger.warn("🚀 Starting Memory Leak Tests...");

    const results = {
      eventListeners: await this.testEventListenerAccumulation(),
      timers: this.testTimerLeaks(),
      closures: this.testClosureLeaks(),
      buffers: this.testBufferAccumulation(),
      webhooks: await this.testWebhookPayloadRetention(),
    };

    // Wait a bit for memory monitoring to detect changes
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const finalReport = MemoryMonitor.getInstance().getMemoryReport();

    logger.warn("📋 FINAL TEST SUMMARY:");
    logger.warn(`  Memory trend: ${finalReport.trend}`);
    logger.warn(
      `  Current heap: ${Math.round(finalReport.current.heapUsed / 1024 / 1024)} MB`,
    );
    logger.warn("  Individual test results:");

    Object.entries(results).forEach(([test, result]) => {
      logger.warn(
        `    ${test}: +${Math.round(result.memoryIncrease / 1024)} KB`,
      );
    });

    // Return serialization-safe summary
    return {
      eventListeners: {
        memoryIncrease: results.eventListeners.memoryIncrease,
        totalConnections:
          results.eventListeners.connectionReport.totalConnections,
        staleConnections:
          results.eventListeners.connectionReport.staleConnections,
      },
      timers: {
        memoryIncrease: results.timers.memoryIncrease,
        activeTimers: results.timers.activeTimers,
      },
      closures: {
        memoryIncrease: results.closures.memoryIncrease,
        retainedCallbacks: results.closures.retainedCallbacks,
      },
      buffers: {
        memoryIncrease: results.buffers.memoryIncrease,
        buffersStored: results.buffers.buffersStored,
        bufferTotalSize: results.buffers.bufferTotalSize,
      },
      webhooks: {
        memoryIncrease: results.webhooks.memoryIncrease,
        retainedPayloads: results.webhooks.retainedPayloads,
      },
      summary: {
        totalMemoryIncrease: Object.values(results).reduce(
          (sum, test) => sum + test.memoryIncrease,
          0,
        ),
        memoryTrend: finalReport.trend,
        currentHeapMB: Math.round(finalReport.current.heapUsed / 1024 / 1024),
      },
    };
  }
}
