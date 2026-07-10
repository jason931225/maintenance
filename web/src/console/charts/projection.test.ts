import { describe, expect, it } from "vitest";

import { DEFAULT_LAMBDA, project, STUDENT_T_NU } from "./projection";

describe("project (change-log 68 정량 투영, deterministic)", () => {
  it("computes known quantiles for a known sample", () => {
    // Hand-computed for [100, 110], λ=0.94:
    //   mean = 0.94·100 + 0.06·110 = 100.6
    //   var  = 0.06·(110−100)² = 6 → σ = √6 ≈ 2.4494897
    //   CI95 = mean ± t(0.975, ν=4)·σ, t = 2.7764451
    //   CVaR95 = mean − 3.2028704·σ (ES factor validated vs Monte Carlo)
    const p = project([100, 110]);
    expect(p).not.toBeNull();
    if (!p) return;
    expect(p.point).toBeCloseTo(100.6, 10);
    expect(p.sigma).toBeCloseTo(2.4494897, 6);
    expect(p.ci95[0]).toBeCloseTo(93.79913, 4);
    expect(p.ci95[1]).toBeCloseTo(107.40087, 4);
    expect(p.cvar95).toBeCloseTo(92.7546, 3);
    expect(p.n).toBe(2);
    expect(p.lambda).toBe(DEFAULT_LAMBDA);
    expect(p.nu).toBe(STUDENT_T_NU);
  });

  it("orders the fat tail below the CI band when σ > 0", () => {
    const p = project([100, 120, 90, 130, 105]);
    expect(p).not.toBeNull();
    if (!p) return;
    expect(p.sigma).toBeGreaterThan(0);
    expect(p.cvar95).toBeLessThan(p.ci95[0]);
    expect(p.ci95[0]).toBeLessThan(p.point);
    expect(p.point).toBeLessThan(p.ci95[1]);
  });

  it("collapses to the point for a constant sample", () => {
    const p = project([5, 5, 5]);
    expect(p).not.toBeNull();
    if (!p) return;
    expect(p.sigma).toBe(0);
    expect(p.ci95).toEqual([5, 5]);
    expect(p.cvar95).toBe(5);
  });

  it("filters non-finite values and returns null for an empty sample", () => {
    expect(project([])).toBeNull();
    expect(project([Number.NaN, Number.POSITIVE_INFINITY])).toBeNull();
    const p = project([Number.NaN, 100, 110]);
    expect(p?.n).toBe(2);
    expect(p?.point).toBeCloseTo(100.6, 10);
  });

  it("is deterministic", () => {
    const sample = [3, 1, 4, 1, 5, 9, 2, 6];
    expect(project(sample)).toEqual(project(sample));
  });
});
