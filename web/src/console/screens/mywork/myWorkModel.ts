// Pure derivations + copy for 내 업무. Week ribbon + per-day due counts are
// derived from the REAL action-inbox `due` stamps (no per-day figure is
// invented — a day with no due item simply shows 0), so every branch is
// unit-testable without a DOM.

import { ko } from "../../../i18n/ko";
import { resolveActionInboxLinkRoute } from "../../../lib/objectRegistry";
import type { ActionInboxItem } from "../overview/overviewModel";

export type {
  ActionInboxItem,
  ActionInboxResponse,
  InboxKind,
} from "../overview/overviewModel";

function isActionInboxLink(link: unknown): link is { kind: string; id: string } {
  if (typeof link !== "object" || link === null) return false;
  const candidate = link as { kind?: unknown; id?: unknown };
  return typeof candidate.kind === "string" && typeof candidate.id === "string";
}

/** Adapt the My Work item shape to the shell-neutral registry resolver. */
export function actionInboxLinkRoute(
  item: ActionInboxItem,
): string | undefined {
  const rawLinks: unknown = item.links;
  const links = Array.isArray(rawLinks)
    ? rawLinks.filter(isActionInboxLink)
    : [];
  return resolveActionInboxLinkRoute(links);
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
    loadMore: string;
    urgency: { now: string; today: string; wait: string; unknown: string };
    status: { pending: string; done: string; unknown: string };
    dueAt: (timestamp: string) => string;
    dueUnavailable: string;
  };
  kind: { approval: string; dispatch: string; work: string; support: string; unknown: string };
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
    loadMore: "Load more",
    urgency: { now: "Now", today: "Today", wait: "Queued", unknown: "Priority unavailable" },
    status: { pending: "Pending", done: "Done", unknown: "Status unavailable" },
    dueAt: (timestamp) => `Due ${timestamp}`,
    dueUnavailable: "Due date unavailable",
  },
  kind: {
    approval: "Approval",
    dispatch: "Dispatch",
    work: "Maintenance",
    support: "Reply",
    unknown: "Work item unavailable",
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
  kind: unknown,
  S: MyWorkStrings,
): string {
  return typeof kind === "string" && kind in S.kind
    ? S.kind[kind as keyof typeof S.kind]
    : S.kind.unknown;
}

/** The API's server-owned urgency enum is the queue priority; never infer it
 * from title, due date, or source kind in the client. */
export function urgencyLabel(
  urgency: unknown,
  S: MyWorkStrings,
): string {
  return typeof urgency === "string" && urgency in S.assigned.urgency
    ? S.assigned.urgency[urgency as keyof typeof S.assigned.urgency]
    : S.assigned.urgency.unknown;
}

/** `done` is the only action-inbox completion state available to this reader. */
export function actionStatusLabel(
  done: unknown,
  S: MyWorkStrings,
): string {
  if (done === true) return S.assigned.status.done;
  if (done === false) return S.assigned.status.pending;
  return S.assigned.status.unknown;
}

/** Completion color follows the same strict server-boolean boundary as status. */
export function actionInboxDoneTone(done: unknown): "ok" | "neutral" {
  return done === true ? "ok" : "neutral";
}

export type ActionInboxTone = "danger" | "warn" | "neutral";

/** Do not let an unexpected server enum crash the presentation component. */
export function actionInboxTone(value: unknown): ActionInboxTone {
  return value === "danger" || value === "warn" || value === "neutral"
    ? value
    : "neutral";
}

/** A transport failure or malformed value must remain visible as unavailable,
 * not become a fabricated local date. */
export function actionInboxDue(value: unknown): Date | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
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
    (n, item) => {
      const due = actionInboxDue(item.due);
      return due && sameDay(due, day) ? n + 1 : n;
    },
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
    (item) => {
      const due = actionInboxDue(item.due);
      return due != null && sameDay(due, filter.day);
    },
  );
}
