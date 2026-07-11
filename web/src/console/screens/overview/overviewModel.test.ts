import { describe, expect, it } from "vitest";

import { overviewStrings } from "./strings";
import {
  filterQueue,
  overviewStats,
  queueChips,
  railCategories,
  timelineEntries,
  type ActionInboxItem,
  type NotificationCountsSummary,
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
