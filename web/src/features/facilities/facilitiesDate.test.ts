import { describe, expect, it } from "vitest";

import { toLocalDateTimeInput } from "./facilitiesDate";

describe("toLocalDateTimeInput", () => {
  it("preserves the browser-local wall clock without serializing a UTC offset", () => {
    const value = new Date(2030, 0, 2, 3, 4, 59);
    expect(toLocalDateTimeInput(value)).toBe("2030-01-02T03:04");
    expect(toLocalDateTimeInput(value)).not.toContain("Z");
  });
});
