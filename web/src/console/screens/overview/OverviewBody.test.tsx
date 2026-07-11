import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { OverviewBody } from "./OverviewBody";
import type { OverviewApi } from "./overviewApi";
import { overviewStrings } from "./strings";
import type {
  ActionInboxItem,
  ActionInboxResponse,
  NotificationCountsSummary,
} from "./overviewModel";
import type { NotificationSummary } from "../../../api/types";

const S = overviewStrings();
const NOW = new Date("2026-07-03T09:00:00Z");

function item(over: Partial<ActionInboxItem> & Pick<ActionInboxItem, "kind" | "id">): ActionInboxItem {
  return {
    kind: over.kind,
    id: over.id,
    urg: "wait",
    ref: "R-1",
    title: "t",
    dueTone: "neutral",
    links: [],
    done: false,
    ...over,
  };
}

const inbox: ActionInboxResponse = {
  total: 3,
  items: [
    item({ kind: "approval", id: "approval:1", urg: "now", dueTone: "danger", title: "Approve budget", due: "2026-07-03T03:00:00Z" }),
    item({ kind: "dispatch", id: "dispatch:1", urg: "today", dueTone: "warn", title: "Assign van" }),
    item({ kind: "support", id: "support:1", title: "Reply ticket" }),
  ],
};

const counts: NotificationCountsSummary = {
  total_unread: 4,
  by_category: [{ category: "cat-a", unread: 4 }],
};

const notifications: NotificationSummary[] = [
  {
    id: "n1",
    recipient_user_id: "u1",
    category: "cat-a",
    kind: "info",
    text: "New assignment",
    link: { kind: "work_order", id: "wo1" } as NotificationSummary["link"],
    unread: true,
    created_at: "2026-07-03T08:50:00Z",
    read_at: null,
    resolved_at: null,
  },
];

function stubApi(over?: Partial<OverviewApi>): OverviewApi {
  return {
    loadInbox: vi.fn().mockResolvedValue(inbox),
    loadNotificationCounts: vi.fn().mockResolvedValue(counts),
    loadNotifications: vi.fn().mockResolvedValue(notifications),
    ...over,
  };
}

function renderBody(props?: Partial<Parameters<typeof OverviewBody>[0]>) {
  return render(
    <MemoryRouter>
      <OverviewBody api={stubApi()} now={NOW} {...props} />
    </MemoryRouter>,
  );
}

describe("OverviewBody", () => {
  it("renders the stat strip, work queue, timeline, and comms feed from real endpoints", async () => {
    renderBody();
    await screen.findByText(S.stat.approval);

    // stat strip: approval count 1 with the urgent sub-chip
    const approvalStat = screen.getByRole("button", {
      name: (n) => n.includes(S.stat.approval),
    });
    expect(within(approvalStat).getByText("1")).toBeInTheDocument();
    expect(screen.getByText(S.stat.urgent(1))).toBeInTheDocument();

    // queue rows + comms feed
    expect(screen.getByText("Approve budget")).toBeInTheDocument();
    expect(screen.getByText("New assignment")).toBeInTheDocument();
    // timeline picks up the approval due today
    expect(screen.getByLabelText(S.timelineTitle)).toBeInTheDocument();
  });

  it("drilling a stat filters the queue to that kind", async () => {
    const user = userEvent.setup();
    renderBody();
    await screen.findByText("Approve budget");

    await user.click(
      screen.getByRole("button", { name: (n) => n.includes(S.stat.dispatch) }),
    );
    expect(screen.getByText("Assign van")).toBeInTheDocument();
    expect(screen.queryByText("Approve budget")).not.toBeInTheDocument();
  });

  it("invokes onOpen with the item when a row action button is pressed", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderBody({ onOpen });
    await screen.findByText("Approve budget");

    await user.click(screen.getByRole("button", { name: S.action.approval }));
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ id: "approval:1" }),
    );
  });

  it("shows the loading chip then clears it", async () => {
    renderBody();
    expect(screen.getByText(S.loading)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText(S.loading)).not.toBeInTheDocument();
    });
  });

  it("renders an error state with retry that re-fetches", async () => {
    const user = userEvent.setup();
    const loadInbox = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(inbox);
    render(
      <MemoryRouter>
        <OverviewBody api={stubApi({ loadInbox })} now={NOW} />
      </MemoryRouter>,
    );
    await screen.findByText(S.error);
    await user.click(screen.getByRole("button", { name: S.retry }));
    await screen.findByText("Approve budget");
  });

  it("shows empty-queue copy when the filter matches nothing", async () => {
    const user = userEvent.setup();
    renderBody();
    await screen.findByText("Approve budget");
    // filter to the work stat (kind=work) — the fixture has none
    await user.click(
      screen.getByRole("button", { name: (n) => n.includes(S.stat.work) }),
    );
    expect(screen.getByText(S.empty.queue)).toBeInTheDocument();
  });
});
