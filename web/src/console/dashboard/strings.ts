// UI copy for the KPI/ops dashboard console surface. check-ui-strings forbids
// Hangul in lane files, so real copy lives in ko.console.dashboard
// (web/src/i18n/ko.ts) and dashboardStrings() below merges it over these
// English FALLBACK defaults (which also keep the surface testable in
// isolation and cover any key a future ko.ts revision might drop).
// The wire-up may also RETIRE now-unused ko.kpi keys: description, period,
// periodPlaceholder, periodHint, periodInvalid, rollup, noReport,
// metricDetails, topDelayReason, noDelayReason, command.* (the deleted
// EXECUTIVE BI rail + raw date-range input copy).
import { ko } from "../../i18n/ko";

export interface DashboardStrings {
  scopeAll: string;
  periodOngoing: (month: string) => string;
  periodClosed: (month: string) => string;
  completionByScope: string;
  delayReasons: string;
  emptyReason: string;
  emptyAction: string;
  /** Body-level error/retry copy (DashboardBody's own fetch failure state). */
  errorReason?: string;
  retry?: string;
  // The keys below are optional on the *contract* so the current ko.ts
  // `dashboard` block (which the serial wire-up has not yet extended) still
  // `satisfies DashboardStrings`. dashboardStrings() fills them from FALLBACK,
  // so they are always defined at the use-site (see the resolved return type).
  /** §4-24 honest month-over-month completion trend + projected current month. */
  trendTitle?: string;
  /** 사업장 커버리지 card (site attendance facts). */
  coverageTitle?: string;
  coverageArrivals?: string;
  coverageDepartures?: string;
  coverageEmpty?: string;
  /** 내 지표 card (caller-scoped payroll readiness — honest, no fabricated ₩). */
  myMetricsTitle?: string;
  myMetricsPeriod?: string;
  myMetricsReady?: string;
  myMetricsPending?: string;
  myMetricsEmpty?: string;
  /** Typed wire-pending marker for aggregates with no backing server endpoint. */
  pendingTitle?: string;
  pendingReason?: string;
  pendingLaborCost?: string;
  pendingContracts?: string;
  pendingInsights?: string;
  /** 지연 사유 분포 chart: work_order.delay_reason enum → Korean label. Keys are the
   *  DB CHECK variants (migration 0008_create_work_orders.sql). Unknown/retired
   *  variants fail closed to delayReasonUnknown — never the raw enum key. */
  delayReasonLabels?: Record<string, string>;
  delayReasonUnknown?: string;
}

const FALLBACK = {
  scopeAll: "All — authorized union",
  periodOngoing: (month) => `${month} — in progress`,
  periodClosed: (month) => `${month} — closed`,
  completionByScope: "Completed by scope",
  delayReasons: "Delay reasons",
  emptyReason: "No approved reports in this period",
  emptyAction: "Open dispatch board",
  trendTitle: "Monthly completion trend",
  coverageTitle: "Worksite coverage",
  coverageArrivals: "Arrivals",
  coverageDepartures: "Departures",
  coverageEmpty: "No attendance events for this scope",
  myMetricsTitle: "My metrics",
  myMetricsPeriod: "Latest payroll period",
  myMetricsReady: "Calculation ready",
  myMetricsPending: "Calculation pending",
  myMetricsEmpty: "No payroll lines assigned to you",
  pendingTitle: "Aggregates pending a backing endpoint",
  pendingReason: "Not shown — no backing server aggregate yet",
  pendingLaborCost: "Labor-cost trend (₩)",
  pendingContracts: "Contract profitability",
  pendingInsights: "Operational insights",
  // koManifest (serial wire-up → ko.console.dashboard.delayReasonLabels):
  //   PART_WAITING "부품 대기", CUSTOMER_ABSENT "고객 부재",
  //   EQUIPMENT_IN_USE "장비 사용 중", MECHANIC_OVERLOADED "정비사 과부하",
  //   OUTSOURCE_DELAY "외주 지연", ADDITIONAL_FAULT_FOUND "추가 결함 발견",
  //   SAFETY_ISSUE "안전 문제", OTHER "기타"; delayReasonUnknown "기타 사유".
  delayReasonLabels: {
    PART_WAITING: "Awaiting parts",
    CUSTOMER_ABSENT: "Customer absent",
    EQUIPMENT_IN_USE: "Equipment in use",
    MECHANIC_OVERLOADED: "Mechanic overloaded",
    OUTSOURCE_DELAY: "Outsourcing delay",
    ADDITIONAL_FAULT_FOUND: "Additional fault found",
    SAFETY_ISSUE: "Safety issue",
    OTHER: "Other",
  } as Record<string, string>,
  delayReasonUnknown: "Other reason",
} satisfies DashboardStrings;

/** The resolved strings: every FALLBACK key is guaranteed present, plus the
 *  optional ko-only error/retry copy. */
export type ResolvedDashboardStrings = typeof FALLBACK &
  Pick<DashboardStrings, "errorReason" | "retry">;

/** ko.console.dashboard accessor, English fallback for keys the wire-up has
 *  not yet landed (this lane must not edit ko.ts). Merged shallowly (FALLBACK
 *  first) so the ko block — which today omits the new keys — never drops them
 *  back to undefined; the cast is sound because FALLBACK supplies them all. */
export function dashboardStrings(): ResolvedDashboardStrings {
  return {
    ...FALLBACK,
    ...((ko.console as unknown as { dashboard?: Partial<DashboardStrings> })
      .dashboard ?? {}),
  };
}
