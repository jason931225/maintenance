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
import type { NotificationSummary } from "../../../api/types";
import { NOTIFICATION_CATEGORY } from "../../../i18n/notificationCategories";
import type { OverviewStrings, RailCategoryStrings } from "./strings";

export type ActionInboxItem = components["schemas"]["ActionInboxItem"];
export type ActionInboxResponse = components["schemas"]["ActionInboxResponse"];
export type NotificationCountsSummary =
  components["schemas"]["NotificationCountsSummary"];
export type NotificationCategoryCount =
  components["schemas"]["NotificationCategoryCount"];
export type MailThreadSummary = components["schemas"]["MailThreadView"];
export type EmployeeAttendanceRecord =
  components["schemas"]["EmployeeAttendanceRecord"];

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

// ── attendance chip (출근): the caller's latest punch today ───────────────────
// A real self-service fact from /api/v1/hr/attendance-records/me (soft-fail —
// non-employee callers 403 and the chip is simply absent). We surface only the
// latest state on today's work_date, mapped to a human label + its clock time.

export interface PunchStatus {
  label: string;
}

const PUNCH_LABEL: Record<
  EmployeeAttendanceRecord["state_after"],
  (S: OverviewStrings, time: string) => string
> = {
  CLOCKED_IN: (S, t) => S.punch.in(t),
  OUT_FOR_WORK: (S, t) => S.punch.out(t),
  BUSINESS_TRIP: (S, t) => S.punch.trip(t),
  OFF_DUTY: (S, t) => S.punch.off(t),
};

/** Local Y-M-D so the compare matches the record's business `work_date`. */
function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayPunch(
  records: readonly EmployeeAttendanceRecord[],
  now: Date,
  timeFmt: Intl.DateTimeFormat,
  S: OverviewStrings,
): PunchStatus | undefined {
  const today = localDate(now);
  // `.at(0)` (not `[0]`) so `latest` is typed `… | undefined` — the empty-set
  // case is real (no punch today) and the guard below must not read as dead.
  const latest = records
    .filter((r) => r.work_date === today)
    .sort(
      (a, b) =>
        new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime(),
    )
    .at(0);
  if (!latest) return undefined;
  return {
    label: PUNCH_LABEL[latest.state_after](
      S,
      timeFmt.format(new Date(latest.occurred_at)),
    ),
  };
}

// ── comms rail (커뮤니케이션): unread-by-category + the feed ───────────────────

export function railCategories(
  counts: NotificationCountsSummary | undefined,
): NotificationCategoryCount[] {
  return (counts?.by_category ?? []).filter((c) => c.unread > 0);
}

// ── comms rail groups (메신저/메일/알림/공지) — verdict R3 density: split the
// flat feed into named panels, all rendered open (no collapse state to
// default — see OverviewBody.tsx). 메신저/공지/알림 bucket the SAME real
// /api/v1/me/notifications feed already fetched (by category); 메일 is a
// second real source (mail doesn't post into notifications) via a small
// extra fetch (overviewApi.ts loadMailThreads).

export interface RailItem {
  id: string;
  text: string;
  createdAt: string;
  unread: boolean;
  /** Raw producer category (e.g. `결재`/`leave`/`메신저`) — the per-item chip
   * localizes it via `categoryLabel`; `mail` for the separate mail source. */
  category: string;
}

export type RailGroupKey = "messenger" | "mail" | "notification" | "notice";

export interface RailGroup {
  key: RailGroupKey;
  title: string;
  items: RailItem[];
}

function notificationItems(
  notifications: readonly NotificationSummary[],
  predicate: (n: NotificationSummary) => boolean,
): RailItem[] {
  return notifications
    .filter(predicate)
    .map((n) => ({
      id: n.id,
      text: n.text,
      createdAt: n.created_at,
      unread: n.unread,
      category: n.category,
    }));
}

export function railGroups(
  notifications: readonly NotificationSummary[],
  mailThreads: readonly MailThreadSummary[],
  categoryLabels: RailCategoryStrings,
): RailGroup[] {
  const isMessenger = (n: NotificationSummary) => n.category === NOTIFICATION_CATEGORY.messenger;
  const isNotice = (n: NotificationSummary) => n.category === NOTIFICATION_CATEGORY.notice;
  return [
    { key: "messenger", title: categoryLabels.messenger, items: notificationItems(notifications, isMessenger) },
    {
      key: "mail",
      title: categoryLabels.mail,
      items: mailThreads.map((t) => ({
        id: t.id,
        text: t.subject,
        createdAt: t.last_message_at,
        unread: t.unread_count > 0,
        category: "mail",
      })),
    },
    {
      key: "notification",
      title: categoryLabels.notification,
      items: notificationItems(notifications, (n) => !isMessenger(n) && !isNotice(n)),
    },
    { key: "notice", title: categoryLabels.notice, items: notificationItems(notifications, isNotice) },
  ];
}

/** Count of unread rows in a rail group — the section's colored badge. */
export function railGroupUnread(items: readonly RailItem[]): number {
  return items.reduce((n, item) => (item.unread ? n + 1 : n), 0);
}

// ── per-item sender avatar (colored monogram) ────────────────────────────────
// The feed carries no sender identity, so the avatar is a deterministic monogram
// of the row's own text: a stable initial + one of a fixed tone set (hashed), so
// the same row always draws the same colored circle across renders and screens.

export type RailAvatarTone = "purple" | "info" | "ok" | "danger" | "accent";

const AVATAR_TONES: readonly RailAvatarTone[] = [
  "purple",
  "info",
  "ok",
  "danger",
  "accent",
];

/** First visible grapheme of `text`, past leading mention/punctuation noise. */
export function railInitial(text: string): string {
  const cleaned = text.replace(/^[\s@#·:\-—[\]()]+/u, "").trim();
  const first = Array.from(cleaned)[0];
  return first ? first.toUpperCase() : "·";
}

/** Deterministic avatar tone from a seed (the row's text). */
export function railAvatarTone(seed: string): RailAvatarTone {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}
