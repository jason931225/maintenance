// UI copy for 업무·운영 개요 (the operations overview). check-ui-strings forbids
// Hangul in lane files and this lane must not edit ko.ts — the serial i18n
// wire-up applies the koManifest below as ko.console.overviewBody; until it
// lands these English defaults keep the surface mountable and testable.
// (ko.console.overview is already taken by the group-scope picker, hence the
// distinct overviewBody key.)
//
// koManifest (proposed Korean for the wire-up, keyed ko.console.overviewBody):
//   title              "업무·운영 개요"
//   queueTitle         "처리 대기"
//   timelineTitle      "오늘"
//   railTitle          "커뮤니케이션"
//   stat.approval      "결재 대기"
//   stat.dispatch      "미배정 배차"
//   stat.today         "오늘 마감"
//   stat.work          "미확인 업무"
//   stat.urgent        (n) => `긴급 ${n}`
//   stat.slaImminent   (n) => `SLA 임박 ${n}`
//   chip.all           "전체"
//   chip.approval      "결재"
//   chip.dispatch      "배차"
//   chip.work          "정비"
//   chip.support       "회신"
//   action.approval    "검토"
//   action.dispatch    "배차"
//   action.work        "확인"
//   action.support     "회신"
//   rail.unread        (n) => `안 읽음 ${n}`
//   empty.queue        "처리할 항목이 없습니다"
//   empty.timeline     "오늘 마감 업무가 없습니다"
//   empty.rail         "새 알림이 없습니다"
//   error              "개요를 불러오지 못했습니다"
//   retry              "다시 시도"
//   loading            "불러오는 중"
import { ko } from "../../../i18n/ko";

export interface OverviewStrings {
  title: string;
  queueTitle: string;
  timelineTitle: string;
  railTitle: string;
  stat: {
    approval: string;
    dispatch: string;
    today: string;
    work: string;
    urgent: (n: number) => string;
    slaImminent: (n: number) => string;
  };
  chip: {
    all: string;
    approval: string;
    dispatch: string;
    work: string;
    support: string;
  };
  action: {
    approval: string;
    dispatch: string;
    work: string;
    support: string;
  };
  rail: { unread: (n: number) => string };
  empty: { queue: string; timeline: string; rail: string };
  error: string;
  retry: string;
  loading: string;
}

const FALLBACK: OverviewStrings = {
  title: "Operations overview",
  queueTitle: "Awaiting action",
  timelineTitle: "Today",
  railTitle: "Communications",
  stat: {
    approval: "Approvals pending",
    dispatch: "Unassigned dispatch",
    today: "Due today",
    work: "Unreviewed work",
    urgent: (n) => `Urgent ${String(n)}`,
    slaImminent: (n) => `SLA at risk ${String(n)}`,
  },
  chip: {
    all: "All",
    approval: "Approval",
    dispatch: "Dispatch",
    work: "Maintenance",
    support: "Reply",
  },
  action: {
    approval: "Review",
    dispatch: "Assign",
    work: "Confirm",
    support: "Reply",
  },
  rail: { unread: (n) => `Unread ${String(n)}` },
  empty: {
    queue: "Nothing awaiting action",
    timeline: "Nothing due today",
    rail: "No new notifications",
  },
  error: "Could not load the overview",
  retry: "Retry",
  loading: "Loading",
};

/** ko.console.overviewBody accessor with the English fallback. */
export function overviewStrings(): OverviewStrings {
  return (
    (ko.console as unknown as { overviewBody?: OverviewStrings }).overviewBody ??
    FALLBACK
  );
}
