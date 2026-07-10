import { describe, expect, it } from "vitest";

import type { CostLedgerEntrySummary } from "../../api/types";
import { fcCode, monthlyCostSample } from "./series";

function entry(entryAt: string, amountWon: number): CostLedgerEntrySummary {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    branch_id: "00000000-0000-4000-8000-000000000002",
    equipment_id: "00000000-0000-4000-8000-000000000003",
    work_order_id: null,
    purchase_request_id: null,
    source: "MANUAL_ADMIN",
    amount_won: amountWon,
    memo: "",
    residual_before_won: 0,
    residual_after_won: 0,
    entry_at: entryAt,
  };
}

const NOW = new Date("2026-07-10T00:00:00Z");

describe("monthlyCostSample", () => {
  it("buckets real entries by month within the trailing horizon, oldest first", () => {
    const entries = [
      entry("2026-05-01T00:00:00Z", 100_000),
      entry("2026-05-15T00:00:00Z", 50_000),
      entry("2026-06-01T00:00:00Z", 200_000),
      entry("2026-07-01T00:00:00Z", 300_000),
    ];
    expect(monthlyCostSample(entries, 3, NOW)).toEqual([150_000, 200_000, 300_000]);
  });

  it("drops entries outside the horizon window (no fabrication, no inclusion)", () => {
    const entries = [entry("2025-01-01T00:00:00Z", 999_999)];
    expect(monthlyCostSample(entries, 3, NOW)).toEqual([]);
  });

  it("returns an empty sample for no entries — insufficient state, not a placeholder", () => {
    expect(monthlyCostSample([], 6, NOW)).toEqual([]);
  });

  it("applies the what-if delta as an explicit scenario multiplier on real data", () => {
    const entries = [entry("2026-07-01T00:00:00Z", 100_000)];
    expect(monthlyCostSample(entries, 3, NOW, 20)).toEqual([120_000]);
    expect(monthlyCostSample(entries, 3, NOW, -10)).toEqual([90_000]);
  });

  it("ignores unparseable timestamps rather than crashing", () => {
    const entries = [entry("not-a-date", 100_000)];
    expect(monthlyCostSample(entries, 3, NOW)).toEqual([]);
  });
});

describe("fcCode", () => {
  it("is deterministic for the same equipment id", () => {
    const id = "aaaa1111-bbbb-2222-cccc-333344445555";
    expect(fcCode(id)).toBe(fcCode(id));
    expect(fcCode(id)).toMatch(/^FC-[0-9A-F]{6}$/);
  });

  it("differs across equipment ids", () => {
    expect(fcCode("aaaa1111-bbbb-2222-cccc-333344445555")).not.toBe(
      fcCode("ffff9999-eeee-8888-dddd-777766665555"),
    );
  });
});
