import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ko } from "../../i18n/ko";
import { HonestBar, HonestSpark } from "./HonestMarks";
import { ProjectionPanel, type BackendProjection } from "./ProjectionPanel";

const T = ko.console.charts;

const narrowBand = [
  { id: "a", label: "창원", value: 9_500_000 },
  { id: "b", label: "부산", value: 9_800_000 },
  { id: "c", label: "울산", value: 10_000_000 },
];

describe("HonestBar (§4-24)", () => {
  it("renders the mandatory truncation warn chip for a narrow band", () => {
    render(<HonestBar label="지점별 정비비" data={narrowBand} onDrill={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toBe(T.truncated("₩9,300,000"));
  });

  it("keeps the 0-baseline (no chip) for wide-variance data", () => {
    render(
      <HonestBar
        label="지점별 정비비"
        data={[
          { id: "a", label: "창원", value: 100 },
          { id: "b", label: "부산", value: 1_000 },
        ]}
        onDrill={vi.fn()}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("drills every row (§4.7-9) and offers the in-place add path (§4-22)", () => {
    const onDrill = vi.fn();
    const onAdd = vi.fn();
    render(<HonestBar label="지점별 정비비" data={narrowBand} onDrill={onDrill} onAdd={onAdd} />);
    fireEvent.click(screen.getByRole("button", { name: T.drill("부산", "₩9,800,000") }));
    expect(onDrill).toHaveBeenCalledWith("b");
    fireEvent.click(screen.getByRole("button", { name: T.add }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});

describe("HonestSpark (§4-24)", () => {
  it("is a single drill target with an accessible name and truncation chip", () => {
    const onDrill = vi.fn();
    render(<HonestSpark label="월 정비비" values={narrowBand.map((d) => d.value)} onDrill={onDrill} />);
    fireEvent.click(screen.getByRole("button", { name: T.spark("월 정비비", "₩10,000,000") }));
    expect(onDrill).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toBe(T.truncated("₩9,300,000"));
  });
});

describe("ProjectionPanel (change-log 68 정량 투영)", () => {
  const sample = [100, 120, 90, 130, 105];

  it("renders point, CI95, CVaR95 and the assumption chips", () => {
    render(<ProjectionPanel title="월 정비비" kind="percent" sample={sample} onDrill={vi.fn()} />);
    expect(screen.getByText(T.projection.point)).toBeTruthy();
    expect(screen.getByText(T.projection.ci95)).toBeTruthy();
    expect(screen.getByText(T.projection.cvar95)).toBeTruthy();
    expect(screen.getByText(T.projection.assumptionEwma("0.94"))).toBeTruthy();
    expect(screen.getByText(T.projection.assumptionDist)).toBeTruthy();
    expect(screen.getByText(T.projection.assumptionN(5))).toBeTruthy();
  });

  it("renders the backend projection assumptions instead of the client decay lambda", () => {
    const backendResult = {
      point_estimate: 111,
      ci95_low: 90,
      ci95_high: 140,
      cvar95: 75,
      assumptions: {
        ewma_volatility: 0.123,
        student_t_nu: 7,
        drift: 0.02,
        simulations: 10_000,
        seed: 42,
      },
    } satisfies BackendProjection;

    render(
      <ProjectionPanel
        title="월 정비비"
        kind="money"
        sample={sample}
        backendResult={backendResult}
        lambda={0.5}
        onDrill={vi.fn()}
      />,
    );

    expect(screen.getByText(T.projection.assumptionEwmaVolatility("0.123"))).toBeTruthy();
    expect(screen.getByText(T.projection.assumptionStudentT(7))).toBeTruthy();
    expect(screen.queryByText(T.projection.assumptionEwma("0.5"))).toBeNull();
  });

  it("drills each stat separately (§4.7-9)", () => {
    const onDrill = vi.fn();
    render(<ProjectionPanel title="월 정비비" kind="money" sample={sample} onDrill={onDrill} />);
    // stat drill names carry the formatted value (WCAG 1.1.1); match on the stat label prefix.
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${T.projection.point} `) }));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${T.projection.ci95} `) }));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${T.projection.cvar95} `) }));
    fireEvent.click(screen.getByRole("button", { name: /^월 정비비 추이 최근 / }));
    expect(onDrill.mock.calls.map((c: unknown[]) => c[0])).toEqual(["point", "ci95", "cvar95", "sample"]);
  });

  it("shows the honest insufficient-sample state with the add path", () => {
    const onAddSample = vi.fn();
    render(<ProjectionPanel title="월 정비비" kind="money" sample={[]} onDrill={vi.fn()} onAddSample={onAddSample} />);
    expect(screen.getByRole("status").textContent).toBe(T.projection.insufficient);
    fireEvent.click(screen.getByRole("button", { name: T.projection.addSample }));
    expect(onAddSample).toHaveBeenCalledTimes(1);
  });
});
