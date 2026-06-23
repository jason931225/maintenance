import { describe, expect, it } from "vitest";

import {
  formatKoreanDate,
  formatKoreanDateTime,
  formatRelativeKo,
} from "./datetime";

describe("formatKoreanDateTime", () => {
  it("renders a UTC instant at the KST wall clock (UTC+9)", () => {
    // 09:00 UTC is 18:00 in Asia/Seoul on the same calendar day.
    expect(formatKoreanDateTime("2026-06-12T09:00:00Z")).toBe(
      "2026-06-12 18:00",
    );
  });

  it("rolls the calendar date forward when KST crosses midnight", () => {
    // 20:30 UTC is 05:30 the NEXT day in Asia/Seoul.
    expect(formatKoreanDateTime("2026-06-12T20:30:00Z")).toBe(
      "2026-06-13 05:30",
    );
  });

  it("does not depend on the host timezone for an offset instant", () => {
    // A +09:00 instant equal to 18:00 KST renders the same wall clock.
    expect(formatKoreanDateTime("2026-06-12T18:00:00+09:00")).toBe(
      "2026-06-12 18:00",
    );
  });

  it("returns the em-dash placeholder for null/empty/invalid input", () => {
    expect(formatKoreanDateTime(null)).toBe("—");
    expect(formatKoreanDateTime(undefined)).toBe("—");
    expect(formatKoreanDateTime("")).toBe("—");
    expect(formatKoreanDateTime("not-a-date")).toBe("—");
  });
});

describe("formatKoreanDate", () => {
  it("renders the KST calendar date for a UTC instant", () => {
    // 23:30 UTC on the 12th is the 13th in Asia/Seoul.
    expect(formatKoreanDate("2026-06-12T23:30:00Z")).toBe("2026-06-13");
  });

  it("returns the em-dash placeholder for missing/invalid input", () => {
    expect(formatKoreanDate(null)).toBe("—");
    expect(formatKoreanDate("nope")).toBe("—");
  });
});

describe("formatRelativeKo", () => {
  const now = new Date("2026-06-12T12:00:00Z");

  it("uses hours for an instant a few hours in the past", () => {
    // 3 hours earlier; ko-KR yields "3시간 전".
    expect(formatRelativeKo("2026-06-12T09:00:00Z", now)).toContain("3");
    expect(formatRelativeKo("2026-06-12T09:00:00Z", now)).toMatch(/시간/);
  });

  it("uses days for an instant several days in the future", () => {
    expect(formatRelativeKo("2026-06-15T12:00:00Z", now)).toMatch(/일/);
  });

  it("returns a non-empty phrase within the now window", () => {
    expect(formatRelativeKo("2026-06-12T12:00:10Z", now)).not.toBe("—");
  });

  it("returns the em-dash placeholder for missing/invalid input", () => {
    expect(formatRelativeKo(null, now)).toBe("—");
    expect(formatRelativeKo("bad", now)).toBe("—");
  });
});
