// UI copy for 업무·운영 개요 (the operations overview), wired to
// ko.console.overviewBody. (ko.console.overview is already taken by the
// group-scope picker, hence the distinct overviewBody key.) The English
// FALLBACK below only guards a future ko.ts regression — same defensive
// convention as railCategoryStrings — not pending keys.
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

/** ko.console.overviewBody accessor with the English fallback (regression guard only). */
export function overviewStrings(): OverviewStrings {
  const wired = (ko.console as unknown as { overviewBody?: Partial<OverviewStrings> })
    .overviewBody;
  return wired ? { ...FALLBACK, ...wired } : FALLBACK;
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
