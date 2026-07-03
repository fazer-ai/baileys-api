import { errorToString } from "@/helpers/errorToString";

interface ValidationValueError {
  path?: string;
  message?: string;
}

// Structural check for an Elysia ValidationError's `.all` failures. A type
// guard (not a bare cast) so accessing the failures stays type-safe, and it
// keeps errorForLog unit-testable without constructing a real ValidationError.
function hasValidationFailures(
  error: unknown,
): error is { all: ValidationValueError[] } {
  return (
    typeof error === "object" &&
    error !== null &&
    Array.isArray((error as { all?: unknown }).all)
  );
}

// Renders an error for logging, redacting VALIDATION errors. Elysia surfaces the
// rejected request value in a validation error's message/stack; for
// POST /connections/:phone/import-session that value is impersonation
// credentials, so for a VALIDATION code we emit only which fields failed and the
// schema-derived reason (never `.value`). All other codes stringify as usual.
export function errorForLog(code: string | number, error: unknown): string {
  if (code !== "VALIDATION" || !hasValidationFailures(error)) {
    return errorToString(error);
  }
  const details = error.all
    .map((e) => `${e.path ?? "?"} (${e.message ?? "invalid"})`)
    .join("; ");
  return details ? `Validation failed: ${details}` : "Validation failed";
}
