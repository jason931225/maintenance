import { describe, expect, it } from "vitest";

import { honestScale } from "./honestScale";

describe("honestScale (§4-24 honest truncation)", () => {
  it("keeps the 0-baseline when relative variance >= 1/3", () => {
    const s = honestScale([10, 100]);
    expect(s.min).toBe(0);
    expect(s.max).toBe(100);
    expect(s.truncated).toBe(false);
    expect(s.norm(50)).toBeCloseTo(0.5, 6);
  });

  it("truncates a narrow positive band and flags the mandatory chip", () => {
    const s = honestScale([9_500_000, 9_800_000, 10_000_000]);
    expect(s.truncated).toBe(true);
    expect(s.min).toBeGreaterThan(0);
    expect(s.min).toBeLessThan(9_500_000);
    // baseline floors to a round step of the spread (10^5)
    expect(s.min % 100_000).toBe(0);
    expect(s.max).toBe(10_000_000);
  });

  it("never truncates data that touches or crosses zero", () => {
    const s = honestScale([-5, 10]);
    expect(s.truncated).toBe(false);
    expect(s.min).toBe(-5);
    expect(s.max).toBe(10);
  });

  it("keeps an all-equal sample readable with a below-min baseline", () => {
    const s = honestScale([550, 550, 550]);
    expect(s.truncated).toBe(true);
    expect(s.min).toBeLessThan(550);
    expect(s.norm(550)).toBe(1);
  });

  it("falls back to the 0-baseline when flooring would cross zero", () => {
    const s = honestScale([0.1, 0.1]);
    expect(s.truncated).toBe(false);
    expect(s.min).toBe(0);
  });

  it("clamps norm to the axis and survives an empty sample", () => {
    const s = honestScale([9_500_000, 10_000_000]);
    expect(s.norm(0)).toBe(0);
    expect(s.norm(20_000_000)).toBe(1);
    const empty = honestScale([]);
    expect(empty.truncated).toBe(false);
    expect(empty.norm(5)).toBeGreaterThanOrEqual(0);
  });
});
