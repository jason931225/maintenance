// UI copy for the 인건비 분석 (labor-cost analysis) console surface. check-ui-strings
// forbids Hangul in lane files and this lane must not edit ko.ts — the serial
// i18n wire-up applies the koManifest below as ko.console.laborcost; until it
// lands these English defaults keep the surface mountable and testable.
//
// koManifest (proposed Korean for the wire-up, keyed ko.console.laborcost):
//   title              "인건비 분석"
//   periodsTitle       "급여 기간"
//   periodDrill        (period: string, status: string) => `${period} ${status} 상세 열기`
//   compositionTitle   "근로시간 구성"
//   hoursRegular       "정규"
//   hoursOvertime      "연장"
//   hoursNight         "야간"
//   hoursHoliday       "휴일"
//   trendTitle         "근로시간 추이"
//   costPendingTitle   "인건비 금액(₩)"
//   costPendingReason  "표시 안 함 — 급여 금액 원천 행이 아직 없어 근로시간만 집계합니다"
//   emptyReason        "집계할 급여 기간이 없습니다"
//   status             { STAGED:"준비", BLOCKED_LEGAL_GATE:"법적 검토 대기",
//                        READY_FOR_REVIEW:"검토 대기", APPROVED:"승인",
//                        ISSUED:"지급", VOID:"무효" }
import { ko } from "../../i18n/ko";

export interface LaborCostStrings {
  title: string;
  periodsTitle: string;
  periodDrill: (period: string, status: string) => string;
  compositionTitle: string;
  hoursRegular: string;
  hoursOvertime: string;
  hoursNight: string;
  hoursHoliday: string;
  trendTitle: string;
  costPendingTitle: string;
  costPendingReason: string;
  emptyReason: string;
  status: Record<string, string>;
}

const FALLBACK: LaborCostStrings = {
  title: "Labor analysis",
  periodsTitle: "Payroll periods",
  periodDrill: (period, status) => `${period} ${status} — open detail`,
  compositionTitle: "Labor-hours composition",
  hoursRegular: "Regular",
  hoursOvertime: "Overtime",
  hoursNight: "Night",
  hoursHoliday: "Holiday",
  trendTitle: "Labor-hours trend",
  costPendingTitle: "Labor cost (₩)",
  costPendingReason: "Not shown — no payroll amount source rows yet; hours only",
  emptyReason: "No payroll periods to aggregate",
  status: {
    STAGED: "Staged",
    BLOCKED_LEGAL_GATE: "Legal gate",
    READY_FOR_REVIEW: "For review",
    APPROVED: "Approved",
    ISSUED: "Issued",
    VOID: "Void",
  },
};

/** ko.console.laborcost accessor with the English fallback (block not yet wired). */
export function laborCostStrings(): LaborCostStrings {
  const wired = (ko.console as unknown as { laborcost?: Partial<LaborCostStrings> })
    .laborcost;
  return wired ? { ...FALLBACK, ...wired, status: { ...FALLBACK.status, ...wired.status } } : FALLBACK;
}
