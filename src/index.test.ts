import { parseMoneyString } from "./index";

describe("src/index.ts", () => {
  describe("parseMoneyString", () => {
    it("should return null for non-string values", () => {
      // Evidence: if (typeof value !== "string") return null;
      expect(parseMoneyString(123)).toBeNull();
      expect(parseMoneyString(undefined)).toBeNull();
      expect(parseMoneyString(null)).toBeNull();
      expect(parseMoneyString({})).toBeNull();
    });

    it("should return null for invalid strings (regex failure)", () => {
      // Evidence: if (!/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(value)) return null;
      expect(parseMoneyString("")).toBeNull();
      expect(parseMoneyString("not-a-number")).toBeNull();
      expect(parseMoneyString("01")).toBeNull(); // leading zero not allowed for >0
      expect(parseMoneyString("123.456")).toBeNull(); // > 2 decimal places
      expect(parseMoneyString("1234567890123")).toBeNull(); // > 12 integer digits
      expect(parseMoneyString("-100")).toBeNull(); // negative numbers not allowed
      expect(parseMoneyString(" 100 ")).toBeNull(); // spaces not allowed
    });

    it("should return null if Number.isFinite fails", () => {
      // Evidence: if (!Number.isFinite(parsed)) return null;
      // The regex naturally protects against Infinity and NaN. 
      // We temporarily bypass the regex check to explicitly exercise the Number.isFinite boundary.
      const originalTest = RegExp.prototype.test;
      RegExp.prototype.test = function (str: string) {
        if (str === "Infinity" || str === "NaN") {
          return true; // Bypass regex for this test
        }
        return originalTest.call(this, str);
      };

      try {
        expect(parseMoneyString("Infinity")).toBeNull();
        expect(parseMoneyString("NaN")).toBeNull();
      } finally {
        RegExp.prototype.test = originalTest;
      }
    });

    it("should parse valid money strings successfully (normal path)", () => {
      expect(parseMoneyString("0")).toBe(0);
      expect(parseMoneyString("10")).toBe(10);
      expect(parseMoneyString("100.5")).toBe(100.5);
      expect(parseMoneyString("12345.67")).toBe(12345.67);
      expect(parseMoneyString("999999999999.99")).toBe(999999999999.99); // max valid boundary
    });
  });
});
