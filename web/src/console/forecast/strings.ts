// UI copy for the forecast (예측) console surface. check-ui-strings forbids
// Hangul in lane files and this lane must not edit ko.ts — the serial i18n
// wire-up applies the koManifest below as ko.console.forecast; until it lands
// these English defaults keep the surface mountable and testable.
//
// koManifest (proposed Korean for the wire-up, keyed ko.console.forecast):
//   equipmentSearchLabel  "설비 검색"
//   equipmentSearchHint   "설비번호·고객·현장으로 검색"
//   changeEquipment       "변경"
//   noResults             "검색 결과 없음"
//   horizonGroupLabel     "투영 기간"
//   horizonMonths         (n: number) => `최근 ${n}개월`
//   whatIfLabel           "예상 변동률 (what-if, %)"
//   seriesTitle           (equipmentNo: string) => `${equipmentNo} 정비비 투영`
//   fcCodeLabel           "예측 개체"
//   emptyReason           "설비를 선택하면 정비비 이력 기반 투영을 표시합니다"
//   loadErrorReason       "정비비 이력을 불러오지 못했습니다"
//   drillToEquipment      "설비 상세 열기"
import { ko } from "../../i18n/ko";

export interface ForecastStrings {
  equipmentSearchLabel: string;
  equipmentSearchHint: string;
  changeEquipment: string;
  noResults: string;
  horizonGroupLabel: string;
  horizonMonths: (n: number) => string;
  whatIfLabel: string;
  seriesTitle: (equipmentNo: string) => string;
  fcCodeLabel: string;
  emptyReason: string;
  loadErrorReason: string;
  drillToEquipment: string;
}

const FALLBACK: ForecastStrings = {
  equipmentSearchLabel: "Search equipment",
  equipmentSearchHint: "Search by equipment no., customer, or site",
  changeEquipment: "Change",
  noResults: "No results",
  horizonGroupLabel: "Projection horizon",
  horizonMonths: (n) => `Trailing ${String(n)} mo.`,
  whatIfLabel: "Expected delta (what-if, %)",
  seriesTitle: (equipmentNo) => `${equipmentNo} maintenance-cost projection`,
  fcCodeLabel: "Forecast object",
  emptyReason: "Select equipment to see a maintenance-cost-ledger projection",
  loadErrorReason: "Could not load maintenance cost history",
  drillToEquipment: "Open equipment detail",
};

/** ko.console.forecast accessor with the English fallback. */
export function forecastStrings(): ForecastStrings {
  return (
    (ko.console as unknown as { forecast?: ForecastStrings }).forecast ??
    FALLBACK
  );
}
