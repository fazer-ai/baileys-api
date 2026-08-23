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

  // Both halves of the late settlement reach the caller, and they are told
  // apart by the argument: an operation that fails slowly leaves the queue
  // exactly like one that succeeds slowly, but only the success is evidence a
  // message went out.
  it("reports a late settlement, with the error when it failed", async () => {
    const settled: unknown[] = [];
    let resolveLate: (value: string) => void = () => {};
    const late = withTimeout(
      "send",
      10,
      () =>
        new Promise<string>((resolve) => {
          resolveLate = resolve;
        }),
      (error) => settled.push(error ?? "ok"),
    );
    await expect(late).rejects.toBeInstanceOf(OperationTimeoutError);
    resolveLate("done");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toEqual(["ok"]);

    const failure = new Error("upload failed");
    let rejectLate: (error: Error) => void = () => {};
    const lateFailure = withTimeout(
      "send",
      10,
      () =>
        new Promise<never>((_, reject) => {
          rejectLate = reject;
        }),
      (error) => settled.push(error ?? "ok"),
    );
    await expect(lateFailure).rejects.toBeInstanceOf(OperationTimeoutError);
    rejectLate(failure);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toEqual(["ok", failure]);
  });

  // A settlement BEFORE the deadline is the caller's own return value; firing
  // the callback for it would report every ordinary send as a late one.
  it("does not report a settlement that beat the deadline", async () => {
    const settled: unknown[] = [];
    await withTimeout(
      "send",
      1000,
      async () => "done",
      () => settled.push("late"),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toEqual([]);
  });
});
