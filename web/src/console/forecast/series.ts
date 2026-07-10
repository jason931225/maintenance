/**
 * Forecast series source — real per-equipment maintenance-cost ledger entries
 * (`AssetLifecycleCostSummary.timeline`, already backend-wired and consumed by
 * console/modules' asset module) bucketed into monthly totals over a trailing
 * horizon window. No fabricated data (§4-25-⑥): entries outside the window are
 * dropped, never invented, and an equipment with zero entries in range yields
 * an empty sample — ProjectionPanel renders its own insufficient-sample state
 * for that, not a placeholder here.
 *
 * wire-pending: HANDOFF §18 Monte-Carlo/EVT service replaces this client-side
 * EWMA (console/charts/projection.ts) once it lands; the sample shape carries
 * over unchanged. True "contract profitability" / isolated "labor cost" series
 * don't exist in the backend yet (no contracts domain, no labor/parts cost
 * split) — this uses the closest real money time series that does.
 */
import type { CostLedgerEntrySummary } from "../../api/types";

export const HORIZON_OPTIONS = [3, 6, 12] as const;
export type HorizonMonths = (typeof HORIZON_OPTIONS)[number];
export const DEFAULT_HORIZON_MONTHS: HorizonMonths = 6;

export const WHAT_IF_MIN_PCT = -50;
export const WHAT_IF_MAX_PCT = 100;

/**
 * Real monthly cost totals (KRW) from ledger entries within the trailing
 * `horizonMonths` window ending at `now`, scaled by an explicit what-if delta
 * (%). The delta is a user-declared scenario multiplier applied to real
 * historical data — not synthesized data — matching the design's what-if
 * pattern (FC-07: slider recomputes the same deterministic quant live).
 */
export function monthlyCostSample(
  entries: readonly CostLedgerEntrySummary[],
  horizonMonths: HorizonMonths,
  now: Date,
  whatIfPct = 0,
): number[] {
  // UTC throughout: entry_at is a UTC server timestamp, and bucketing by local
  // time would shift entries across month boundaries depending on the
  // caller's timezone offset.
  const since = new Date(now);
  since.setUTCMonth(since.getUTCMonth() - horizonMonths);
  const buckets = new Map<string, number>();
  for (const entry of entries) {
    const at = new Date(entry.entry_at);
    if (Number.isNaN(at.getTime()) || at < since || at > now) continue;
    const key = `${String(at.getUTCFullYear())}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
    buckets.set(key, (buckets.get(key) ?? 0) + entry.amount_won);
  }
  const scale = 1 + whatIfPct / 100;
  return [...buckets.keys()].sort().map((key) => (buckets.get(key) ?? 0) * scale);
}

/**
 * Deterministic display code for the projection instance, e.g. `FC-A1B2C3` —
 * presentation framing only (design directive: forecast rows are FC- typed
 * objects), not a real ontology-registered object. wire-pending: register a
 * real FC- ObjectType + instance once the forecast/quant module lands
 * (console-program-ledger "forecast/quant module full build" epic); this code
 * stays stable (derived from equipmentId) so the swap is mechanical.
 */
export function fcCode(equipmentId: string): string {
  return `FC-${equipmentId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}
