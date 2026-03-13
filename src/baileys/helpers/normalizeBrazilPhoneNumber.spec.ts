import { describe, expect, it } from "bun:test";
import { normalizeBrazilPhoneNumber } from "./normalizeBrazilPhoneNumber";

describe("normalizeBrazilPhoneNumber", () => {
  describe("when the phone number matches the Brazilian 8-digit pattern", () => {
    it("adds the extra digit 9 for Sao Paulo (DDD 11)", () => {
      expect(normalizeBrazilPhoneNumber("+551112345678")).toBe(
        "+5511912345678",
      );
    });

    it("adds the extra digit 9 for Rio de Janeiro (DDD 21)", () => {
      expect(normalizeBrazilPhoneNumber("+552112345678")).toBe(
        "+5521912345678",
      );
    });

    it("adds the extra digit 9 for other DDDs", () => {
      expect(normalizeBrazilPhoneNumber("+554812345678")).toBe(
        "+5548912345678",
      );
    });
  });

  describe("when the phone number does not match the pattern", () => {
    it("returns the same number if it already has 9 digits (mobile)", () => {
      expect(normalizeBrazilPhoneNumber("+5511912345678")).toBe(
        "+5511912345678",
      );
    });

    it("returns the same number for non-Brazilian numbers", () => {
      expect(normalizeBrazilPhoneNumber("+14155551234")).toBe("+14155551234");
    });

    it("returns the same number if missing + prefix", () => {
      expect(normalizeBrazilPhoneNumber("551112345678")).toBe("551112345678");
    });

    it("returns the same number for empty string", () => {
      expect(normalizeBrazilPhoneNumber("")).toBe("");
    });

    it("returns the same number for shorter Brazilian numbers", () => {
      expect(normalizeBrazilPhoneNumber("+55111234567")).toBe("+55111234567");
    });
  });
});
