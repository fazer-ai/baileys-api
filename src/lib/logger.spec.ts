import { describe, expect, it } from "bun:test";
import { deepSanitizeObject } from "./logger";

describe("deepSanitizeObject", () => {
  it("truncates strings longer than 50 characters", () => {
    const longStr = "a".repeat(100);
    const result = deepSanitizeObject({ text: longStr });
    expect(result.text).toBe(`${"a".repeat(50)}...`);
  });

  it("does not truncate strings shorter than or equal to 50 characters", () => {
    const shortStr = "hello";
    const result = deepSanitizeObject({ text: shortStr });
    expect(result.text).toBe("hello");
  });

  it("omits specified keys by replacing with ********", () => {
    const result = deepSanitizeObject(
      { secret: "my-key", visible: "ok" },
      { omitKeys: ["secret"] },
    );
    expect(result.secret).toBe("********");
    expect(result.visible).toBe("ok");
  });

  it("sanitizes nested objects recursively", () => {
    const result = deepSanitizeObject({
      nested: { text: "a".repeat(100) },
    });
    expect((result.nested as any).text).toBe(`${"a".repeat(50)}...`);
  });

  it("sanitizes arrays", () => {
    const result = deepSanitizeObject({
      items: ["a".repeat(100), "short"],
    });
    expect((result.items as string[])[0]).toBe(`${"a".repeat(50)}...`);
    expect((result.items as string[])[1]).toBe("short");
  });

  it("truncates arrays longer than 3 items", () => {
    const result = deepSanitizeObject({
      items: [1, 2, 3, 4, 5, 6],
    });
    const items = result.items as unknown[];
    expect(items).toHaveLength(4);
    expect(items[0]).toBe(1);
    expect(items[1]).toBe(2);
    expect(items[2]).toBe(3);
    expect(items[3]).toBe("... and 3 more");
  });

  it("does not truncate arrays with 3 or fewer items", () => {
    const result = deepSanitizeObject({
      items: ["a", "b", "c"],
    });
    expect(result.items).toEqual(["a", "b", "c"]);
  });

  it("preserves numbers and booleans", () => {
    const result = deepSanitizeObject({
      count: 42,
      flag: true,
    });
    expect(result.count).toBe(42);
    expect(result.flag).toBe(true);
  });

  it("does not mutate the original object", () => {
    const original = { secret: "value", text: "a".repeat(100) };
    deepSanitizeObject(original, { omitKeys: ["secret"] });
    expect(original.secret).toBe("value");
    expect(original.text).toBe("a".repeat(100));
  });

  it("handles empty objects", () => {
    const result = deepSanitizeObject({});
    expect(result).toEqual({});
  });
});
