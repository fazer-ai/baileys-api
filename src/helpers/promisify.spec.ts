import { describe, expect, it } from "bun:test";
import { promisify } from "./promisify";

describe("promisify", () => {
  it("returns an object with promise, resolve, and reject", () => {
    const result = promisify<string>();
    expect(result).toHaveProperty("promise");
    expect(result).toHaveProperty("resolve");
    expect(result).toHaveProperty("reject");
    expect(result.promise).toBeInstanceOf(Promise);
    expect(typeof result.resolve).toBe("function");
    expect(typeof result.reject).toBe("function");
  });

  it("resolves the promise when resolve is called", async () => {
    const { promise, resolve } = promisify<string>();
    resolve("hello");
    const result = await promise;
    expect(result).toBe("hello");
  });

  it("rejects the promise when reject is called", async () => {
    const { promise, reject } = promisify<string>();
    const error = new Error("fail");
    reject(error);
    await expect(promise).rejects.toThrow("fail");
  });

  it("works with different generic types", async () => {
    const { promise, resolve } = promisify<number>();
    resolve(42);
    expect(await promise).toBe(42);
  });
});
