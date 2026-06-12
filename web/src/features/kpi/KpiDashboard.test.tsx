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

    expect(
      screen.getByRole("heading", { name: "임원 KPI 대시보드" }),
    ).toBeVisible();
    expect(screen.getByText("18건")).toBeVisible();
    expect(screen.getByText("정기검사 계획 이행률")).toBeVisible();
    expect(screen.getAllByText("데이터 수집 전")[0]).toBeVisible();
    expect(screen.getByText("정기검사 도메인 병합 대기")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "지점 보기" }));

    expect(screen.getByText("7건")).toBeVisible();
    expect(screen.queryByText("18건")).not.toBeInTheDocument();
  });
});
