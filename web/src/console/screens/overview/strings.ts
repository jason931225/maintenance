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
//   punch.in           (t) => `출근 ${t}`
//   punch.out          (t) => `외근 ${t}`
//   punch.trip         (t) => `출장 ${t}`
//   punch.off          (t) => `퇴근 ${t}`
//   empty.queue        "처리할 항목이 없습니다"
//   empty.timeline     "오늘 마감 업무가 없습니다"
//   empty.rail         "새 알림이 없습니다"
//   error              "개요를 불러오지 못했습니다"
//   retry              "다시 시도"
//   loading            "불러오는 중"
//   footer.shown       (shown, total) => `전체 ${total}건 중 ${shown}건 표시`
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
  punch: {
    in: (time: string) => string;
    out: (time: string) => string;
    trip: (time: string) => string;
    off: (time: string) => string;
  };
  empty: { queue: string; timeline: string; rail: string };
  footer: { shown: (shown: number, total: number) => string };
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
  punch: {
    in: (t) => `Clocked in ${t}`,
    out: (t) => `On site ${t}`,
    trip: (t) => `Business trip ${t}`,
    off: (t) => `Clocked out ${t}`,
  },
  empty: {
    queue: "Nothing awaiting action",
    timeline: "Nothing due today",
    rail: "No new notifications",
  },
  footer: { shown: (shown, total) => `Showing ${String(shown)} of ${String(total)}` },
  error: "Could not load the overview",
  retry: "Retry",
  loading: "Loading",
};

/** ko.console.overviewBody accessor with the English fallback.
 *
 * `punch`/`footer` are backfilled per-field: ko.console.overviewBody is
 * already wired (title/stat/chip/… are Korean) but the 출근 chip keys and the
 * r13 `footer` rollup are NEW and the serial i18n wire applies them to ko.ts
 * separately (see koManifest above). Until then the wired object lacks them,
 * so we merge the English default in — same defensive convention as
 * rail.categories — rather than let S.punch/S.footer be undefined. */
export function overviewStrings(): OverviewStrings {
  const wired = (ko.console as unknown as { overviewBody?: Partial<OverviewStrings> })
    .overviewBody;
  if (!wired) return FALLBACK;
  return {
    ...wired,
    punch: wired.punch ?? FALLBACK.punch,
    footer: wired.footer ?? FALLBACK.footer,
  } as OverviewStrings;
}

// ko.console.overviewBody.rail.categories is now real (wired in ko.ts,
// serial wire round 4). Kept as a per-field defensive pick (same convention
// as LeaveConsole/EvidenceScreenBody) as a guard against a future ko.ts
// regression rather than because the keys are pending.
export interface RailCategoryStrings {
  messenger: string;
  mail: string;
  notification: string;
  notice: string;
}

const RAIL_CATEGORY_FALLBACK: RailCategoryStrings = {
  messenger: "Messenger",
  mail: "Mail",
  notification: "Notifications",
  notice: "Notices",
};

export function railCategoryStrings(): RailCategoryStrings {
  const rail = (ko.console as unknown as { overviewBody?: { rail?: { categories?: Partial<RailCategoryStrings> } } })
    .overviewBody?.rail;
  return { ...RAIL_CATEGORY_FALLBACK, ...rail?.categories };
}
