/**
 * DESIGN §4-24 chart honest-scaling (binding).
 *
 * Truncate the axis ONLY when the relative variance of the data is below
 * ~1/3 of its magnitude (a 0-baseline would render visually identical
 * marks); otherwise the baseline stays at 0. Whenever `truncated` is true
 * the caller MUST render the mandatory warn chip
 * ko.console.charts.truncated ("축 절단 — 기준 ₩x (0 아님)").
 */
export interface HonestScale {
  /** Axis baseline. 0 unless honest truncation applies. */
  min: number;
  /** Axis top. */
  max: number;
  /** True → the warn chip is mandatory at the render site. */
  truncated: boolean;
  /** Position of a value on the axis, clamped to 0..1. */
  norm: (value: number) => number;
}

const TRUNCATION_THRESHOLD = 1 / 3;

function withNorm(min: number, max: number, truncated: boolean): HonestScale {
  const span = max - min;
  return {
    min,
    max,
    truncated,
    norm: (value: number) => (span <= 0 ? 0 : Math.min(1, Math.max(0, (value - min) / span))),
  };
}

export function honestScale(values: number[]): HonestScale {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return withNorm(0, 1, false);
  const dataMax = Math.max(...finite);
  const dataMin = Math.min(...finite);
  // Zero-crossing or negative data always keeps its true baseline.
  if (dataMin <= 0) return withNorm(dataMin, Math.max(dataMax, 0), false);
  const spread = dataMax - dataMin;
  if ((dataMax - dataMin) / dataMax >= TRUNCATION_THRESHOLD) return withNorm(0, dataMax, false);
  // Narrow band → truncation allowed. Floor the baseline to a round step so
  // the warn chip shows a clean 기준 value.
  const step = 10 ** Math.floor(Math.log10(spread > 0 ? spread : dataMax));
  let base = Math.floor((dataMin - spread * 0.25) / step) * step;
  if (base >= dataMin) base -= step; // all-equal samples: keep the marks readable
  if (base <= 0) return withNorm(0, dataMax, false);
  return withNorm(base, dataMax, true);
}
