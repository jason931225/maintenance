// Pure derivations + copy for 내 업무. Week ribbon + per-day due counts are
// derived from the REAL action-inbox `due` stamps (no per-day figure is
// invented — a day with no due item simply shows 0), so every branch is
// unit-testable without a DOM.

import { ko } from "../../../i18n/ko";
import { objectRegistry, type ObjectKind } from "../../../lib/objectRegistry";
import type { ActionInboxItem } from "../overview/overviewModel";

export type {
  ActionInboxItem,
  ActionInboxResponse,
  InboxKind,
} from "../overview/overviewModel";

const ACTION_LINK_KINDS: Readonly<Partial<Record<string, ObjectKind>>> = {
  approval_run: "approval",
  work_order: "workOrder",
  support_ticket: "support",
  person: "person",
  org_unit: "org",
  payroll_period: "payroll",
};

/**
 * Resolve the first explicitly registered source-object link. Unknown kinds and
 * blank ids are intentionally inert; the action kind/id is not an object-ref
 * contract and must never be guessed as a fallback destination.
 */
export function actionInboxLinkRoute(
  item: ActionInboxItem,
): string | undefined {
  for (const link of item.links) {
    const objectKind = ACTION_LINK_KINDS[link.kind];
    const id = link.id.trim();
    if (!objectKind || id.length === 0) continue;
    return objectRegistry[objectKind].route({ id, name: link.label });
  }
  return undefined;
}

// ── copy (defensive-pick off ko.console.mywork with a Korean fallback; this
// lane must not edit ko.ts — the koManifest lands the keys later) ─────────────

export interface MyWorkStrings {
  title: string;
  todos: {
    title: string;
    addPlaceholder: string;
    addButton: string;
    empty: string;
    showDone: string;
    doneToggle: (text: string) => string;
    deleteLabel: (text: string) => string;
    createFailed: string;
    mutateFailed: string;
  };
  assigned: {
    title: string;
    empty: string;
    allDays: string;
    today: string;
    open: string;
  };
  kind: { approval: string; dispatch: string; work: string; support: string };
  error: string;
  retry: string;
  loading: string;
}

// English safety net only — the real Korean product copy lives in
// ko.console.mywork (check-ui-strings forbids Hangul outside src/i18n). ko fully
// overrides this at runtime; this renders only if the ko block is ever missing.
const FALLBACK: MyWorkStrings = {
  title: "My work",
  todos: {
    title: "To-dos",
    addPlaceholder: "Add a to-do",
    addButton: "Add",
    empty: "No to-dos",
    showDone: "Show completed",
    doneToggle: (t) => `Toggle done: ${t}`,
    deleteLabel: (t) => `Delete: ${t}`,
    createFailed: "Could not add the to-do",
    mutateFailed: "Could not apply the change",
  },
  assigned: {
    title: "Assigned work",
    empty: "No assigned work",
    allDays: "This week",
    today: "Today",
    open: "Open",
  },
  kind: {
    approval: "Approval",
    dispatch: "Dispatch",
    work: "Maintenance",
    support: "Reply",
  },
  error: "Could not load",
  retry: "Retry",
  loading: "Loading",
};

export function myWorkStrings(): MyWorkStrings {
  const wired = (ko.console as unknown as { mywork?: Partial<MyWorkStrings> })
    .mywork;
  return wired ? { ...FALLBACK, ...wired } : FALLBACK;
}

export function kindLabel(
  kind: ActionInboxItem["kind"],
  S: MyWorkStrings,
): string {
  return S.kind[kind];
}

// ── week ribbon (real per-day due counts) ────────────────────────────────────

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Mon–Sun week containing `now`. */
export function weekDays(now: Date): Date[] {
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

/** Count of assigned items whose `due` falls on `day` (real dues only). */
export function dueCountOn(
  items: readonly ActionInboxItem[],
  day: Date,
): number {
  return items.reduce(
    (n, item) => (item.due && sameDay(new Date(item.due), day) ? n + 1 : n),
    0,
  );
}

export type DayFilter = "all" | { day: Date };

export function filterAssigned(
  items: readonly ActionInboxItem[],
  filter: DayFilter,
): ActionInboxItem[] {
  if (filter === "all") return [...items];
  return items.filter(
    (item) => item.due != null && sameDay(new Date(item.due), filter.day),
  );
}
