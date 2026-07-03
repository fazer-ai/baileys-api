import { describe, expect, it } from "bun:test";
import { errorForLog } from "@/helpers/errorForLog";

describe("errorForLog", () => {
  it("stringifies non-VALIDATION errors as usual", () => {
    const out = errorForLog("INTERNAL_SERVER_ERROR", new Error("boom"));
    expect(out).toContain("boom");
  });

  it("redacts a VALIDATION error to field paths + schema reasons, never the value", () => {
    const error = {
      all: [
        {
          path: "/session/advSecretKey",
          message: "Expected string",
          value: "super-secret-impersonation-credential",
        },
      ],
    };

    const out = errorForLog("VALIDATION", error);

    expect(out).toBe(
      "Validation failed: /session/advSecretKey (Expected string)",
    );
    // The rejected value (impersonation credentials) must never reach the log.
    expect(out).not.toContain("super-secret-impersonation-credential");
  });

  it("falls back to a generic message for a VALIDATION error with no failures", () => {
    expect(errorForLog("VALIDATION", { all: [] })).toBe("Validation failed");
  });

  it("stringifies a VALIDATION code that is not a validation-shaped error", () => {
    const out = errorForLog("VALIDATION", new Error("weird"));
    expect(out).toContain("weird");
  });
});
