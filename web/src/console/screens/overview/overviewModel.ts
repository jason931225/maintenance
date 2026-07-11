// Pure derivation for 업무·운영 개요 (the operations workbench). Everything the
// OverviewBody renders — stat strip, queue chips/filter, today's timeline, the
// comms rail — is derived here from the two REAL W1 endpoints
// (/api/v1/me/action-inbox + /api/v1/me/notifications/summary), so the view is a
// dumb consumer and every branch is unit-testable without a DOM.
//
// The action inbox already fans in the caller's actionable items across four
// person-scoped sources (approval tasks, P1 dispatch offers, support tickets,
// assigned work orders) bucketed by urgency — see the endpoint's own
// description. We derive the stat strip FROM that same list rather than a second
// count endpoint, so a stat can never disagree with the queue below it.

import type { components } from "@maintenance/api-client-ts";
import type { OverviewStrings } from "./strings";

export type ActionInboxItem = components["schemas"]["ActionInboxItem"];
export type ActionInboxResponse = components["schemas"]["ActionInboxResponse"];
export type NotificationCountsSummary =
  components["schemas"]["NotificationCountsSummary"];
export type NotificationCategoryCount =
  components["schemas"]["NotificationCategoryCount"];

export type InboxKind = ActionInboxItem["kind"]; // "approval" | "dispatch" | "work" | "support"
export type QueueFilter = "all" | InboxKind | "today";

const KIND_ORDER: InboxKind[] = ["approval", "dispatch", "work", "support"];

function countWhere(
  items: readonly ActionInboxItem[],
  pred: (item: ActionInboxItem) => boolean,
): number {
  return items.reduce((n, item) => (pred(item) ? n + 1 : n), 0);
}

// ── stat strip (§4-11: one compact row, every stat drills) ───────────────────

export interface OverviewStat {
  key: string;
  label: string;
  value: number;
  sub?: { text: string; tone: "warn" | "danger" };
  filter: QueueFilter;
}

export function overviewStats(
  items: readonly ActionInboxItem[],
  S: OverviewStrings,
): OverviewStat[] {
  const urgentApprovals = countWhere(
    items,
    (i) => i.kind === "approval" && i.urg === "now",
  );
  const slaImminent = countWhere(
    items,
    (i) => i.kind === "dispatch" && i.dueTone !== "neutral",
  );
  return [
    {
      key: "approval",
      label: S.stat.approval,
      value: countWhere(items, (i) => i.kind === "approval"),
      sub:
        urgentApprovals > 0
          ? { text: S.stat.urgent(urgentApprovals), tone: "danger" }
          : undefined,
      filter: "approval",
    },
    {
      key: "dispatch",
      label: S.stat.dispatch,
      value: countWhere(items, (i) => i.kind === "dispatch"),
      sub:
        slaImminent > 0
          ? { text: S.stat.slaImminent(slaImminent), tone: "warn" }
          : undefined,
      filter: "dispatch",
    },
    {
      key: "today",
      label: S.stat.today,
      value: countWhere(items, (i) => i.urg === "today"),
      filter: "today",
    },
    {
      key: "work",
      label: S.stat.work,
      value: countWhere(items, (i) => i.kind === "work"),
      filter: "work",
    },
  ];
}

// ── work queue (처리 대기): type chips + filter predicate ─────────────────────

export interface QueueChip {
  filter: QueueFilter;
  label: string;
  count: number;
}

export function queueChips(
  items: readonly ActionInboxItem[],
  S: OverviewStrings,
): QueueChip[] {
  const chips: QueueChip[] = [{ filter: "all", label: S.chip.all, count: items.length }];
  for (const kind of KIND_ORDER) {
    chips.push({
      filter: kind,
      label: S.chip[kind],
      count: countWhere(items, (i) => i.kind === kind),
    });
  }
  return chips;
}

export function filterQueue(
  items: readonly ActionInboxItem[],
  filter: QueueFilter,
): ActionInboxItem[] {
  if (filter === "all") return [...items];
  if (filter === "today") return items.filter((i) => i.urg === "today");
  return items.filter((i) => i.kind === filter);
}

export function actionLabel(kind: InboxKind, S: OverviewStrings): string {
  return S.action[kind];
}

export function kindLabel(kind: InboxKind, S: OverviewStrings): string {
  return S.chip[kind];
}

/** Fallback drill target when the mount supplies no onOpen — the source screen. */
export function kindRoute(kind: InboxKind): string {
  return {
    approval: "/approvals",
    dispatch: "/dispatch",
    work: "/maintenance",
    support: "/support",
  }[kind];
}

export function chipTone(
  tone: ActionInboxItem["dueTone"],
): "danger" | "warn" | "neutral" {
  return tone;
}

// ── today timeline (오늘): the inbox items that fall due today, time-sorted ────
// No meeting/standup source exists, so the timeline is honestly built from the
// same actionable items — the ones with a due stamp on the current day (§4-25-⑥).

export interface TimelineEntry {
  item: ActionInboxItem;
  time: string;
}

export function timelineEntries(
  items: readonly ActionInboxItem[],
  now: Date,
  timeFmt: Intl.DateTimeFormat,
): TimelineEntry[] {
  return items
    .flatMap((item) => (item.due ? [{ item, at: new Date(item.due) }] : []))
    .filter(
      ({ at }) =>
        at.getFullYear() === now.getFullYear() &&
        at.getMonth() === now.getMonth() &&
        at.getDate() === now.getDate(),
    )
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map(({ item, at }) => ({ item, time: timeFmt.format(at) }));
}

// ── comms rail (커뮤니케이션): unread-by-category + the feed ───────────────────

export function railCategories(
  counts: NotificationCountsSummary | undefined,
): NotificationCategoryCount[] {
  return (counts?.by_category ?? []).filter((c) => c.unread > 0);
}
