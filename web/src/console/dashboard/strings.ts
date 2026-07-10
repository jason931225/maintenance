// UI copy for the KPI/ops dashboard console surface. check-ui-strings forbids
// Hangul in lane files and this lane must not edit ko.ts — the serial i18n
// wire-up applies the koManifest below as ko.console.dashboard; until it lands
// these English defaults keep the surface mountable and testable.
//
// koManifest (proposed Korean for the wire-up, keyed ko.console.dashboard):
//   scopeAll          "전체 — 인가 합집합"
//   periodOngoing     (month) => `${month} — 진행`
//   periodClosed      (month) => `${month} — 확정`
//   completionByScope "범위별 완료 건수"
//   delayReasons      "지연 사유 분포"
//   emptyReason       "이 기간에 집계된 승인 보고가 없습니다"
//   emptyAction       "배차 보드 열기"
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
}

const FALLBACK: DashboardStrings = {
  scopeAll: "All — authorized union",
  periodOngoing: (month) => `${month} — in progress`,
  periodClosed: (month) => `${month} — closed`,
  completionByScope: "Completed by scope",
  delayReasons: "Delay reasons",
  emptyReason: "No approved reports in this period",
  emptyAction: "Open dispatch board",
};

/** ko.console.dashboard accessor with the English fallback. */
export function dashboardStrings(): DashboardStrings {
  return (
    (ko.console as unknown as { dashboard?: DashboardStrings }).dashboard ??
    FALLBACK
  );
}
