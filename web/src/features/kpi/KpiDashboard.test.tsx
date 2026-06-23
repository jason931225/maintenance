import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { KpiDashboard } from "./KpiDashboard";
import { kpiReport } from "../../test/fixtures";

describe("KpiDashboard", () => {
  it("switches visible rollups and renders unavailable metrics honestly", async () => {
    const user = userEvent.setup();
    const onPeriodChange = vi.fn();

    render(
      <KpiDashboard
        isLoading={false}
        period="2026-06-01..2026-07-01"
        report={kpiReport}
        onPeriodChange={onPeriodChange}
      />,
    );

    // The page-level <h1> owns the title now (PageHeader on KpiPage); the panel
    // renders only the live summary line, so the heading is no longer duplicated.
    expect(
      screen.queryByRole("heading", { name: "임원 KPI 대시보드" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/승인 보고/)).toBeVisible();
    expect(screen.getByText("18건")).toBeVisible();
    expect(screen.getByText("정기검사 계획 이행률")).toBeVisible();
    expect(screen.getAllByText("데이터 수집 전")[0]).toBeVisible();
    expect(screen.getByText("정기검사 도메인 병합 대기")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "지점 보기" }));

    expect(screen.getByText("7건")).toBeVisible();
    expect(screen.queryByText("18건")).not.toBeInTheDocument();
  });

  it("renders computed P1 acceptance and inspection-plan rates when available", () => {
    const onPeriodChange = vi.fn();
    const report = {
      ...kpiReport,
      unavailable_metrics: [],
      rollups: [
        {
          ...kpiReport.rollups[0],
          inspection_schedule_due_count: 3,
          inspection_schedule_completed_count: 2,
          inspection_plan_completion_bps: 6_666,
          p1_dispatch_count: 4,
          p1_accepted_count: 3,
          p1_acceptance_bps: 7_500,
        },
      ],
    };

    render(
      <KpiDashboard
        isLoading={false}
        period="2026-06-01..2026-07-01"
        report={report}
        onPeriodChange={onPeriodChange}
      />,
    );

    expect(screen.getByText("66.7%")).toBeVisible();
    expect(screen.getByText("75%")).toBeVisible();
    expect(screen.getByText("P1 수락: 3건/4건")).toBeVisible();
    expect(screen.getByText("정기점검 완료: 2건/3건")).toBeVisible();
  });
});
