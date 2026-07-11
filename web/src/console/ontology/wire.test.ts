import { describe, expect, it } from "vitest";

import { displayValue } from "./wire";

describe("displayValue money formatting", () => {
  it("renders a money-typed won integer with the shared ₩ helper (§4-18), never raw", () => {
    // The inspector regression: a `money` property was leaking "36000000".
    expect(displayValue(36_000_000, "money")).toBe("₩36,000,000");
    expect(displayValue(1_860_000, "money")).toBe("₩1,860,000");
    // Numeric strings on the wire coerce and format too.
    expect(displayValue("36000000", "money")).toBe("₩36,000,000");
  });

  it("falls through for a non-numeric or already-formatted money value (never ₩NaN)", () => {
    expect(displayValue("₩1,860,000", "money")).toBe("₩1,860,000");
    expect(displayValue("협의", "money")).toBe("협의");
  });

  it("leaves non-money types untouched and preserves deny-by-omission for null", () => {
    expect(displayValue(74, "percent")).toBe("74");
    expect(displayValue("NK보안", "text")).toBe("NK보안");
    expect(displayValue(null, "money")).toBeNull();
    expect(displayValue(undefined, "money")).toBeNull();
  });
});
