/**
 * DESIGN change-log (68) 정량 투영 — deterministic statistical projection.
 *
 * Pure client-side math over a passed sample: EWMA point estimate + EWMA σ,
 * CI95 and CVaR95 under a fat-tailed Student-t (ν=4). No AI, no randomness.
 *
 * wire-pending: Phase C — backend Monte-Carlo/EVT (HANDOFF §18) replaces this
 * client math behind the same Projection shape.
 */

/** RiskMetrics EWMA decay. */
export const DEFAULT_LAMBDA = 0.94;
export const STUDENT_T_NU = 4;

// Fixed ν=4 Student-t quantiles (textbook values); constants beat shipping an
// inverse-t implementation for a pinned ν.
const T_975_NU4 = 2.7764451052; // two-sided 95%
const T_95_NU4 = 2.1318467863; // one-sided 5% tail

// Student-t(ν=4) pdf: normalizing constant is exactly 3/8.
const tPdfNu4 = (t: number) => 0.375 * (1 + (t * t) / 4) ** -2.5;

// Expected-shortfall multiplier for the lower 5% tail of standardized t(ν=4):
// ES = (f(t_q)/α) · (ν + t_q²)/(ν − 1) ≈ 3.2029 (validated vs Monte Carlo).
const ES_FACTOR_NU4 = (tPdfNu4(T_95_NU4) / 0.05) * ((STUDENT_T_NU + T_95_NU4 * T_95_NU4) / (STUDENT_T_NU - 1));

export interface Projection {
  /** EWMA point estimate. */
  point: number;
  /** EWMA volatility. */
  sigma: number;
  /** 95% confidence band around the point estimate (Student-t ν=4). */
  ci95: readonly [number, number];
  /** Expected value inside the worst 5% tail (fat-tail downside). */
  cvar95: number;
  lambda: number;
  nu: typeof STUDENT_T_NU;
  /** Finite sample size actually used. */
  n: number;
}

/** Returns null when the sample has no finite values. */
export function project(sample: number[], lambda: number = DEFAULT_LAMBDA): Projection | null {
  const xs = sample.filter((v) => Number.isFinite(v));
  if (xs.length === 0) return null;
  let mean = xs[0];
  let variance = 0;
  for (let i = 1; i < xs.length; i += 1) {
    const d = xs[i] - mean;
    variance = lambda * variance + (1 - lambda) * d * d;
    mean = lambda * mean + (1 - lambda) * xs[i];
  }
  const sigma = Math.sqrt(variance);
  return {
    point: mean,
    sigma,
    ci95: [mean - T_975_NU4 * sigma, mean + T_975_NU4 * sigma],
    cvar95: mean - ES_FACTOR_NU4 * sigma,
    lambda,
    nu: STUDENT_T_NU,
    n: xs.length,
  };
}
