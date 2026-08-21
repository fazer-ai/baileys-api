import { describe, expect, it } from "bun:test";
import { OperationTimeoutError, withTimeout } from "@/helpers/withTimeout";

describe("withTimeout", () => {
  it("resolves when the work finishes before the deadline", async () => {
    await expect(withTimeout("op", 1000, async () => "done")).resolves.toBe(
      "done",
    );
  });

  it("propagates a rejection from the work untouched", async () => {
    const error = new Error("boom");
    await expect(
      withTimeout("op", 1000, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });

  it("rejects with OperationTimeoutError when the work never settles", async () => {
    const promise = withTimeout("send", 10, () => new Promise<never>(() => {}));
    await expect(promise).rejects.toBeInstanceOf(OperationTimeoutError);
    await promise.catch((error: OperationTimeoutError) => {
      expect(error.operation).toBe("send");
      expect(error.timeoutMs).toBe(10);
    });
  });

  // The timed-out operation stays parked in the keystore mutex and may reject
  // minutes later. Without the internal `.catch`, that lands as an unhandled
  // rejection long after the request was already answered.
  it("does not surface a late rejection as an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      let rejectLate: (error: Error) => void = () => {};
      const promise = withTimeout(
        "send",
        10,
        () =>
          new Promise<never>((_, reject) => {
            rejectLate = reject;
          }),
      );

      await expect(promise).rejects.toBeInstanceOf(OperationTimeoutError);
      rejectLate(new Error("late failure"));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
