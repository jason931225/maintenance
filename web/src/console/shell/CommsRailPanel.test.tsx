import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CommsRailPanel } from "./CommsRailPanel";
import type { CommsRailApi } from "../screens/overview/overviewApi";
import type { NotificationSummary } from "../../api/types";

function stubApi(over?: Partial<CommsRailApi>): CommsRailApi {
  return {
    loadNotificationCounts: vi.fn().mockResolvedValue({ total_unread: 0, by_category: [] }),
    loadNotifications: vi.fn().mockResolvedValue([]),
    loadMailThreads: vi.fn().mockResolvedValue([]),
    ...over,
  };
}

describe("CommsRailPanel", () => {
  it("renders the grouped notification feed from real endpoints", async () => {
    const notifications: NotificationSummary[] = [
      {
        id: "n1",
        recipient_user_id: "u1",
        category: "messenger",
        kind: "info",
        text: "New assignment",
        link: { kind: "work_order", id: "wo1" } as NotificationSummary["link"],
        unread: true,
        created_at: "2026-07-03T08:50:00Z",
        read_at: null,
        resolved_at: null,
      },
    ];
    render(
      <CommsRailPanel
        api={stubApi({
          loadNotificationCounts: vi
            .fn()
            .mockResolvedValue({ total_unread: 1, by_category: [{ category: "messenger", unread: 1 }] }),
          loadNotifications: vi.fn().mockResolvedValue(notifications),
        })}
      />,
    );
    expect(await screen.findByText("New assignment")).toBeInTheDocument();
    // 08:50 UTC renders at the KST wall clock (17:50); locks the date path that
    // used to throw a RangeError and take down the whole console shell.
    expect(screen.getByText("17:50")).toBeInTheDocument();
  });

  it("renders a row with a garbage created_at without throwing", async () => {
    const notifications: NotificationSummary[] = [
      {
        id: "n1",
        recipient_user_id: "u1",
        category: "messenger",
        kind: "info",
        text: "Broken timestamp",
        link: { kind: "work_order", id: "wo1" } as NotificationSummary["link"],
        unread: true,
        // A malformed timestamp must degrade this one row to an empty time
        // label, never throw out of Intl.format.
        created_at: "not-a-date",
        read_at: null,
        resolved_at: null,
      },
    ];
    render(
      <CommsRailPanel
        api={stubApi({ loadNotifications: vi.fn().mockResolvedValue(notifications) })}
      />,
    );
    expect(await screen.findByText("Broken timestamp")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("shows an empty-state per group when nothing is unread", async () => {
    render(<CommsRailPanel api={stubApi()} />);
    const empties = await screen.findAllByText("새 알림이 없습니다");
    // 4 groups (메신저/메일/알림/공지), all empty.
    expect(empties.length).toBe(4);
  });
});
