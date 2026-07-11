import { describe, expect, it } from "vitest";

import type { NotificationSummary } from "../../../api/types";
import { overviewStrings, railCategoryStrings } from "./strings";
import {
  filterQueue,
  overviewStats,
  queueChips,
  railAvatarTone,
  railCategories,
  railGroups,
  railGroupUnread,
  railInitial,
  timelineEntries,
  todayPunch,
  type ActionInboxItem,
  type EmployeeAttendanceRecord,
  type MailThreadSummary,
  type NotificationCountsSummary,
  type RailItem,
} from "./overviewModel";

const S = overviewStrings();

function item(over: Partial<ActionInboxItem> & Pick<ActionInboxItem, "kind">): ActionInboxItem {
  return {
    id: `${over.kind}:${Math.random().toString(36).slice(2)}`,
    kind: over.kind,
    urg: "wait",
    ref: "R-1",
    title: "t",
    dueTone: "neutral",
    links: [],
    done: false,
    ...over,
  };
}

const items: ActionInboxItem[] = [
  item({ kind: "approval", urg: "now", dueTone: "danger" }),
  item({ kind: "approval", urg: "wait" }),
  item({ kind: "dispatch", urg: "today", dueTone: "warn" }),
  item({ kind: "work", urg: "today" }),
  item({ kind: "support", urg: "wait" }),
];

describe("overviewStats", () => {
  it("derives counts and urgency sub-chips from the same inbox the queue shows", () => {
    const stats = overviewStats(items, S);
    const byKey = Object.fromEntries(stats.map((s) => [s.key, s]));
    expect(byKey.approval.value).toBe(2);
    expect(byKey.approval.sub?.text).toBe(S.stat.urgent(1));
    expect(byKey.dispatch.value).toBe(1);
    expect(byKey.dispatch.sub?.text).toBe(S.stat.slaImminent(1));
    expect(byKey.today.value).toBe(2); // dispatch + work are urg=today
    expect(byKey.work.value).toBe(1);
  });

  it("omits the sub-chip when there is no urgent/at-risk item", () => {
    const stats = overviewStats([item({ kind: "approval", urg: "wait" })], S);
    expect(stats[0].sub).toBeUndefined();
  });
});

describe("queueChips + filterQueue", () => {
  it("counts every chip and filters by kind, all, and today", () => {
    const chips = queueChips(items, S);
    expect(chips.map((c) => c.count)).toEqual([5, 2, 1, 1, 1]);
    expect(filterQueue(items, "all")).toHaveLength(5);
    expect(filterQueue(items, "approval")).toHaveLength(2);
    expect(filterQueue(items, "today")).toHaveLength(2);
  });
});

describe("timelineEntries", () => {
  // Local-constructed dates so "due today" (a local-day comparison, as a user
  // experiences it) is TZ-independent in CI.
  const now = new Date(2026, 6, 3, 9, 0);
  const at = (hour: number) => new Date(2026, 6, 3, hour, 0).toISOString();
  const fmt = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });

  it("keeps only items due today, sorted ascending by due time", () => {
    const withDue = [
      item({ kind: "approval", due: at(14) }),
      item({ kind: "dispatch", due: at(11) }),
      item({ kind: "work", due: new Date(2026, 6, 4, 11, 0).toISOString() }), // tomorrow — excluded
      item({ kind: "support" }), // no due — excluded
    ];
    const entries = timelineEntries(withDue, now, fmt);
    expect(entries).toHaveLength(2);
    expect(entries[0].item.kind).toBe("dispatch");
    expect(entries[1].item.kind).toBe("approval");
  });
});

describe("todayPunch", () => {
  const now = new Date(2026, 6, 3, 9, 0);
  const fmt = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  // work_date is a local business day; build it the same way the deriver does
  // so the compare is TZ-independent in CI.
  const pad = (n: number) => String(n).padStart(2, "0");
  const workDate = `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  function rec(
    over: Partial<EmployeeAttendanceRecord>,
  ): EmployeeAttendanceRecord {
    return {
      id: "att-1",
      employee_id: "emp-1",
      employee_display_name: "Kim",
      kind: "CLOCK_IN",
      occurred_at: new Date(2026, 6, 3, 8, 52).toISOString(),
      work_date: workDate,
      state_after: "CLOCKED_IN",
      payroll_material_ref_id: "ref-1",
      payroll_link_status: "LINKED",
      duplicate: false,
      ...over,
    };
  }

  it("labels the latest state on today's work_date with its clock time", () => {
    const punch = todayPunch([rec({})], now, fmt, S);
    expect(punch?.label).toBe(S.punch.in(fmt.format(new Date(2026, 6, 3, 8, 52))));
  });

  it("picks the most recent record of the day (clock-out after clock-in)", () => {
    const punch = todayPunch(
      [
        rec({ id: "a", occurred_at: new Date(2026, 6, 3, 8, 52).toISOString() }),
        rec({
          id: "b",
          kind: "CLOCK_OUT",
          state_after: "OFF_DUTY",
          occurred_at: new Date(2026, 6, 3, 18, 5).toISOString(),
        }),
      ],
      now,
      fmt,
      S,
    );
    expect(punch?.label).toBe(S.punch.off(fmt.format(new Date(2026, 6, 3, 18, 5))));
  });

  it("returns undefined when no record falls on today", () => {
    expect(
      todayPunch([rec({ work_date: "2026-07-02" })], now, fmt, S),
    ).toBeUndefined();
    expect(todayPunch([], now, fmt, S)).toBeUndefined();
  });
});

describe("railCategories", () => {
  it("drops zero-unread categories", () => {
    const counts: NotificationCountsSummary = {
      total_unread: 6,
      by_category: [
        { category: "결재", unread: 5 },
        { category: "근태", unread: 0 },
        { category: "공지", unread: 1 },
      ],
    };
    expect(railCategories(counts).map((c) => c.category)).toEqual(["결재", "공지"]);
    expect(railCategories(undefined)).toEqual([]);
  });
});

describe("railGroups", () => {
  const L = railCategoryStrings();

  function notification(over: Partial<NotificationSummary> & Pick<NotificationSummary, "category">): NotificationSummary {
    return {
      id: `n-${over.category}-${Math.random().toString(36).slice(2)}`,
      recipient_user_id: "u1",
      kind: "info",
      text: "t",
      link: null,
      unread: true,
      created_at: "2026-07-03T08:00:00Z",
      read_at: null,
      resolved_at: null,
      ...over,
    };
  }

  const mailThread: MailThreadSummary = {
    id: "mail-1",
    subject: "견적 회신",
    last_message_at: "2026-07-03T07:00:00Z",
    message_count: 2,
    unread_count: 1,
    has_attachments: false,
    is_flagged: false,
  };

  it("buckets 메신저/공지 by category, everything else into 알림, and 메일 from the separate mail source", () => {
    const notifications = [
      notification({ category: "메신저" }),
      notification({ category: "공지" }),
      notification({ category: "결재" }),
    ];
    const groups = railGroups(notifications, [mailThread], L);
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));

    expect(byKey.messenger.items).toHaveLength(1);
    expect(byKey.messenger.items[0].id).toBe(notifications[0].id);
    expect(byKey.notice.items).toHaveLength(1);
    expect(byKey.notice.items[0].id).toBe(notifications[1].id);
    expect(byKey.notification.items).toHaveLength(1);
    expect(byKey.notification.items[0].id).toBe(notifications[2].id);
    expect(byKey.mail.items).toEqual([
      { id: "mail-1", text: "견적 회신", createdAt: "2026-07-03T07:00:00Z", unread: true, category: "mail" },
    ]);
  });

  it("carries each notification's raw category onto its rail item (per-item chip source)", () => {
    const groups = railGroups([notification({ category: "결재", id: "keep" })], [], L);
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
    expect(byKey.notification.items[0].category).toBe("결재");
  });

  it("every group renders even when empty (no filler, but no missing panel either)", () => {
    const groups = railGroups([], [], L);
    expect(groups).toHaveLength(4);
    expect(groups.every((g) => g.items.length === 0)).toBe(true);
  });
});

describe("railGroupUnread", () => {
  const row = (unread: boolean): RailItem => ({
    id: Math.random().toString(36).slice(2),
    text: "t",
    createdAt: "2026-07-03T08:00:00Z",
    unread,
    category: "결재",
  });

  it("counts only the unread rows", () => {
    expect(railGroupUnread([row(true), row(false), row(true)])).toBe(2);
    expect(railGroupUnread([])).toBe(0);
  });
});

describe("railInitial + railAvatarTone", () => {
  it("takes the first visible grapheme past mention/punctuation noise", () => {
    expect(railInitial("@전성진 님이 멘션했습니다")).toBe("전");
    expect(railInitial("대한제강 구매팀")).toBe("대");
    expect(railInitial("  · WO-2643")).toBe("W");
    expect(railInitial("")).toBe("·");
  });

  it("is deterministic and within the tone set", () => {
    const tones = new Set(["purple", "info", "ok", "danger", "accent"]);
    expect(railAvatarTone("MT-2608")).toBe(railAvatarTone("MT-2608"));
    expect(tones.has(railAvatarTone("배차 관제"))).toBe(true);
  });
});
