import { describe, expect, it } from "bun:test";
import { errorToString } from "./errorToString";

describe("errorToString", () => {
  it("returns the stack trace for Error instances with a stack", () => {
    const error = new Error("something broke");
    expect(errorToString(error)).toBe(error.stack as string);
  });

  it("returns the message when Error has no stack", () => {
    const error = new Error("no stack");
    error.stack = undefined;
    expect(errorToString(error)).toBe("no stack");
  });

  it("returns the string as-is for string errors", () => {
    expect(errorToString("raw error string")).toBe("raw error string");
  });

  it("returns JSON for non-null objects", () => {
    const obj = { code: 42, reason: "timeout" };
    expect(errorToString(obj)).toBe(JSON.stringify(obj));
  });

  it("returns empty string for null", () => {
    expect(errorToString(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(errorToString(undefined)).toBe("");
  });

  it("returns empty string for numbers", () => {
    expect(errorToString(42)).toBe("");
  });

  it("returns empty string for booleans", () => {
    expect(errorToString(true)).toBe("");
  });
});
