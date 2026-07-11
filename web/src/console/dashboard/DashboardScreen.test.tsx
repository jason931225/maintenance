import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type {
  AttendanceSummaryItem,
  MyPayrollLine,
  OpsSummary,
} from "../../api/types";
import { DashboardScreen } from "./DashboardScreen";
import { dashboardStrings } from "./strings";
import { kpiReport } from "../../test/fixtures";

const S = dashboardStrings();

const opsSummary: OpsSummary = {
  funnel: { received: 2, assigned: 1, in_progress: 3, completed: 5 },
  aging_hours: 24,
  aging_work_orders: 1,
  sla_breached: 1,
  sla_at_risk: 2,
  mechanic_load: [],
  equipment_status: { rented: 10, spare: 4, scrapped: 1, replacement: 2, sold: 0 },
  active_substitutions: 1,
  pending_approvals: 2,
  open_support_tickets: 4,
};

// Fixture period is 2026-06; segments are derived from "now", so pin the clock
// to keep the ongoing/closed month labels deterministic.
const NOW = new Date("2026-07-10T09:00:00Z");

function renderScreen(overrides?: Partial<Parameters<typeof DashboardScreen>[0]>) {
  const onPeriodChange = vi.fn();
  render(
    <MemoryRouter>
      <DashboardScreen
        report={kpiReport}
        opsSummary={opsSummary}
        period="2026-07-01..2026-08-01"
        isLoading={false}
        onPeriodChange={onPeriodChange}
        {...overrides}
      />
    </MemoryRouter>,
  );
  return { onPeriodChange };
}

describe("DashboardScreen", () => {
  it("switches visible rollups via PBAC-relative scope segments and keeps unavailable metrics honest", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    try {
      renderScreen();

      // Company scope is the authorized union, never a big-number card grid.
      expect(
        screen.getByRole("button", { name: "회사 보기" }),
      ).toHaveTextContent(S.scopeAll);
      expect(
        screen.getByRole("link", { name: "완료 건수 18건 상세 열기" }),
      ).toBeVisible();
      // Unavailable metrics render as status chips with the API-provided reason.
      expect(screen.getAllByText("데이터 수집 전")[0]).toBeVisible();
      expect(screen.getByText("정기검사 도메인 병합 대기")).toBeVisible();

      // Non-company segments show resolved display names, never raw ids
      // (both in the scope chips and the scope-comparison chart rows).
      expect(screen.getAllByText(/지점 · 창원지점/)[0]).toBeVisible();
      expect(screen.getAllByText(/권역 · 경남권역/)[0]).toBeVisible();
      expect(screen.getAllByText(/정비사 · 김정비/)[0]).toBeVisible();
      expect(
        screen.queryByText("abababab-abab-4bab-8bab-abababababab"),
      ).not.toBeInTheDocument();

      const user = userEvent.setup({
        advanceTimers: (ms) => vi.advanceTimersByTime(ms),
      });
      await user.click(screen.getByRole("button", { name: "지점 보기" }));
      expect(
        screen.getByRole("link", { name: "완료 건수 7건 상세 열기" }),
      ).toBeVisible();
      expect(
        screen.queryByRole("link", { name: "완료 건수 18건 상세 열기" }),
      ).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders computed P1 acceptance and inspection-plan rates when available", () => {
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
    renderScreen({ report });

    expect(screen.getByText("66.7%")).toBeVisible();
    expect(screen.getByText("75%")).toBeVisible();
    expect(screen.getByText("P1 수락: 3건/4건")).toBeVisible();
    expect(screen.getByText("정기점검 완료: 2건/3건")).toBeVisible();
  });

  it("drills every stat to its source screen", () => {
    renderScreen();

    // KPI stats drill into the object-set screens that source them.
    expect(
      screen.getByRole("link", { name: "완료 건수 18건 상세 열기" }),
    ).toHaveAttribute("href", "/dispatch?status=COMPLETED");
    // Ops stats drill to approvals/support/ops.
    expect(
      screen.getByRole("link", { name: "승인 대기 2건 상세 열기" }),
    ).toHaveAttribute("href", "/approvals");
    expect(
      screen.getByRole("link", { name: "미해결 문의 4건 상세 열기" }),
    ).toHaveAttribute("href", "/support");
    expect(
      screen.getByRole("link", { name: "SLA 위반 1건 상세 열기" }),
    ).toHaveAttribute("href", "/ops");
  });

  it("offers typed month segments instead of a raw date-format input", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    try {
      const { onPeriodChange } = renderScreen();

      // §4-19: no free-text period input survives the rebuild.
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(
        screen.queryByPlaceholderText("YYYY-MM-DD..YYYY-MM-DD"),
      ).not.toBeInTheDocument();

      const group = screen.getByRole("group", { name: "기간" });
      const ongoing = within(group).getByRole("button", {
        name: S.periodOngoing("7월"),
      });
      expect(ongoing).toHaveAttribute("aria-pressed", "true");

      const user = userEvent.setup({
        advanceTimers: (ms) => vi.advanceTimersByTime(ms),
      });
      await user.click(
        within(group).getByRole("button", { name: S.periodClosed("6월") }),
      );
      expect(onPeriodChange).toHaveBeenCalledWith("2026-06-01..2026-07-01");
    } finally {
      vi.useRealTimers();
    }
  });

  it("charts scope completion and delay reasons on an honest scale with drills", async () => {
    const user = userEvent.setup();
    renderScreen();

    // Delay reasons come from the API distribution of the selected rollup —
    // keyed by the raw enum variant, localized for display (never shown raw).
    const delayChart = screen.getByRole("group", { name: S.delayReasons });
    expect(within(delayChart).getByText(S.delayReasonLabels.PART_WAITING)).toBeVisible();
    expect(within(delayChart).getByText(S.delayReasonLabels.ADDITIONAL_FAULT_FOUND)).toBeVisible();
    // The raw enum key must never leak into the chart.
    expect(within(delayChart).queryByText("ADDITIONAL_FAULT_FOUND")).toBeNull();

    const scopeChart = screen.getByRole("group", { name: S.completionByScope });
    // Drilling a scope row selects that scope in the strip.
    await user.click(
      within(scopeChart).getByRole("button", { name: /김정비.+4건/ }),
    );
    expect(screen.getByText("승인 보고 4건", { exact: false })).toBeVisible();
  });

  it("localizes every delay_reason enum variant (never the raw key)", () => {
    // The full work_order.delay_reason enum — migration 0008_create_work_orders.sql.
    const DELAY_REASON_VARIANTS = [
      "PART_WAITING",
      "CUSTOMER_ABSENT",
      "EQUIPMENT_IN_USE",
      "MECHANIC_OVERLOADED",
      "OUTSOURCE_DELAY",
      "ADDITIONAL_FAULT_FOUND",
      "SAFETY_ISSUE",
      "OTHER",
    ] as const;
    for (const variant of DELAY_REASON_VARIANTS) {
      const label = S.delayReasonLabels[variant];
      expect(label).toBeTruthy();
      expect(label).not.toBe(variant);
    }
  });

  it("fails closed to a neutral label for an unknown/retired delay_reason variant", () => {
    renderScreen({
      report: {
        ...kpiReport,
        rollups: [
          {
            ...kpiReport.rollups[0],
            delay_reason_distribution: { RETIRED_LEGACY_REASON: 3 },
          },
        ],
      },
    });
    const delayChart = screen.getByRole("group", { name: S.delayReasons });
    expect(within(delayChart).getByText(S.delayReasonUnknown)).toBeVisible();
    expect(within(delayChart).queryByText("RETIRED_LEGACY_REASON")).toBeNull();
  });

  it("omits fabricated sections and deleted explanatory copy", () => {
    renderScreen();

    // The EXECUTIVE BI caption block, explanatory subtitle, and load
    // placeholder are gone (§4-12).
    expect(screen.queryByText(/Executive BI/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText("전체·세부 범위 성과를 실행 화면과 연결합니다."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("KPI 데이터를 불러오면 표시됩니다."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("기간별 핵심 운영 지표를 집계해 보여줍니다."),
    ).not.toBeInTheDocument();
  });

  it("renders the cold-start empty state as reason plus next action", () => {
    renderScreen({
      report: { ...kpiReport, rollups: [], unavailable_metrics: [] },
      opsSummary: undefined,
    });

    expect(screen.getByText(S.emptyReason)).toBeVisible();
    expect(screen.getByRole("link", { name: S.emptyAction })).toHaveAttribute(
      "href",
      "/dispatch",
    );
    // No fabricated stats or chart panels against an empty backend.
    expect(screen.queryByRole("group", { name: S.completionByScope })).not.toBeInTheDocument();
  });

  it("shows the §4-24 honest completion-projection panel for a real ≥3-month series", () => {
    renderScreen({ trend: [10, 12, 15] });
    // ProjectionPanel titles the region "<field> 정량 투영"; the projection is
    // over real data, so the insufficient-sample chip must NOT appear.
    expect(
      screen.getByRole("region", { name: new RegExp(S.trendTitle) }),
    ).toBeVisible();
    expect(screen.queryByText("표본 부족")).not.toBeInTheDocument();
  });

  it("omits the projection entirely below the honest 3-point floor (never over-claims)", () => {
    renderScreen({ trend: [10, 12] });
    expect(
      screen.queryByRole("region", { name: new RegExp(S.trendTitle) }),
    ).not.toBeInTheDocument();
  });

  it("renders the coverage card from real attendance facts and drills to attendance", () => {
    const coverage: AttendanceSummaryItem[] = [
      { user_id: "u1", display_name: "김정비", arrivals: 3, departures: 2 },
    ];
    renderScreen({ coverage });
    const card = screen.getByRole("link", { name: S.coverageTitle });
    expect(card).toHaveAttribute("href", "/attendance");
    expect(within(card).getByText("김정비")).toBeVisible();
    expect(within(card).getByText(/3건.+2건/)).toBeVisible();
  });

  it("renders the coverage empty state when authorized but no attendance rows", () => {
    renderScreen({ coverage: [] });
    expect(screen.getByText(S.coverageEmpty)).toBeVisible();
  });

  it("omits the coverage card entirely when the viewer is not authorized (deny-by-omission)", () => {
    renderScreen();
    expect(
      screen.queryByRole("link", { name: S.coverageTitle }),
    ).not.toBeInTheDocument();
  });

  it("renders my-metrics readiness honestly (period + status chip, no fabricated ₩)", () => {
    const myMetrics: MyPayrollLine[] = [
      {
        run_id: "r1",
        period_start: "2026-06-01",
        period_end: "2026-07-01",
        run_status: "APPROVED",
        calculation_status: "APPROVED",
        gross_pay_source_present: true,
        net_pay_source_present: true,
      },
    ];
    renderScreen({ myMetrics });
    const card = screen.getByRole("link", { name: S.myMetricsTitle });
    expect(card).toHaveAttribute("href", "/payroll");
    expect(within(card).getByText(S.myMetricsReady)).toBeVisible();
    // No fabricated take-home number is invented from a source-present flag.
    expect(within(card).queryByText(/₩/)).not.toBeInTheDocument();
  });

  it("names the aggregates that have no backing endpoint as typed wire-pending markers", () => {
    renderScreen();
    const pending = screen.getByRole("region", { name: S.pendingTitle });
    expect(within(pending).getByText(S.pendingLaborCost)).toBeVisible();
    expect(within(pending).getByText(S.pendingContracts)).toBeVisible();
    expect(within(pending).getByText(S.pendingInsights)).toBeVisible();
  });
});
