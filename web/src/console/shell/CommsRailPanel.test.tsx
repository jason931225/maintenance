import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CommsRailPanel } from "./CommsRailPanel";
import { ko } from "../../i18n/ko";
import type { CommsRailApi } from "../screens/overview/overviewApi";
import type { NotificationSummary } from "../../api/types";

function stubApi(over?: Partial<CommsRailApi>): CommsRailApi {
  return {
    loadNotificationCounts: vi.fn().mockResolvedValue({ total_unread: 0, by_category: [] }),
    loadNotifications: vi.fn().mockResolvedValue([]),
    loadMailThreads: vi.fn().mockResolvedValue([]),
    markAllNotificationsRead: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

function notif(over: Partial<NotificationSummary> & Pick<NotificationSummary, "id" | "category" | "text">): NotificationSummary {
  return {
    recipient_user_id: "u1",
    kind: "info",
    link: { kind: "work_order", id: "wo1" } as NotificationSummary["link"],
    unread: true,
    created_at: "2026-07-03T08:50:00Z",
    read_at: null,
    resolved_at: null,
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

  it("never renders raw unread-scope debug pills (untranslated key + raw count)", async () => {
    // Even when the counts endpoint reports by-category unread, the rail must not
    // surface the old '메신저1 / leave1 / support2' debug chips: the design ref
    // has no such row (the per-group headers already carry the counts).
    render(
      <CommsRailPanel
        api={stubApi({
          loadNotificationCounts: vi.fn().mockResolvedValue({
            total_unread: 3,
            by_category: [
              { category: "메신저", unread: 1 },
              { category: "leave", unread: 1 },
              { category: "support", unread: 2 },
            ],
          }),
        })}
      />,
    );
    await screen.findAllByText("새 알림이 없습니다");
    expect(screen.queryByText("leave")).not.toBeInTheDocument();
    expect(screen.queryByText("support")).not.toBeInTheDocument();
    expect(screen.queryByText(/^메신저\s*1$/)).not.toBeInTheDocument();
  });

  it("shows an empty-state per group when nothing is unread", async () => {
    render(<CommsRailPanel api={stubApi()} />);
    const empties = await screen.findAllByText("새 알림이 없습니다");
    // 4 groups (메신저/메일/알림/공지), all empty.
    expect(empties.length).toBe(4);
  });

  it("renders a colored monogram avatar and a two-line preview per row", async () => {
    render(
      <CommsRailPanel
        api={stubApi({
          loadNotifications: vi
            .fn()
            .mockResolvedValue([notif({ id: "n1", category: "메신저", text: "배차 관제에서 회신 대기 중" })]),
        })}
      />,
    );
    // preview text (the row body)
    expect(await screen.findByText("배차 관제에서 회신 대기 중")).toBeInTheDocument();
    // monogram initial — first visible glyph of the text
    expect(screen.getByText("배")).toBeInTheDocument();
  });

  it("localizes the per-item category chip on 알림 rows (r13 chips intact)", async () => {
    render(
      <CommsRailPanel
        api={stubApi({
          // 'leave' is a raw producer key → must render as 연차, never raw.
          loadNotifications: vi.fn().mockResolvedValue([notif({ id: "n1", category: "leave", text: "연차 신청 상신" })]),
        })}
      />,
    );
    expect(await screen.findByText("연차 신청 상신")).toBeInTheDocument();
    expect(screen.getByText("연차")).toBeInTheDocument();
    expect(screen.queryByText("leave")).not.toBeInTheDocument();
  });

  it("badges each section with its unread count", async () => {
    render(
      <CommsRailPanel
        api={stubApi({
          loadNotifications: vi.fn().mockResolvedValue([
            notif({ id: "a", category: "결재", text: "결재 A", unread: true }),
            notif({ id: "b", category: "결재", text: "결재 B", unread: true }),
            notif({ id: "c", category: "결재", text: "결재 C", unread: false }),
          ]),
        })}
      />,
    );
    await screen.findByText("결재 A");
    // 2 of the 3 알림 rows are unread → the section badge reads its unread count.
    const badge = screen.getByLabelText(ko.console.overviewBody.rail.unread(2));
    expect(badge).toHaveTextContent("2");
  });

  it("fires the read-all endpoint from 모두 읽음 and clears the unread rows", async () => {
    const markAllNotificationsRead = vi.fn().mockResolvedValue(undefined);
    render(
      <CommsRailPanel
        api={stubApi({
          loadNotifications: vi
            .fn()
            .mockResolvedValue([notif({ id: "a", category: "결재", text: "결재 대기", unread: true })]),
          markAllNotificationsRead,
        })}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: ko.shell.commsRail.markAllRead }));
    expect(markAllNotificationsRead).toHaveBeenCalledTimes(1);
    // Optimistic: once read, the unread badge and the 모두 읽음 action both clear.
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: ko.shell.commsRail.markAllRead }),
      ).not.toBeInTheDocument();
    });
  });
});
