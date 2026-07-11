import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { OverviewBody } from "./OverviewBody";
import type { OverviewApi } from "./overviewApi";
import { overviewStrings } from "./strings";
import type { ActionInboxItem, ActionInboxResponse } from "./overviewModel";

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

function stubApi(over?: Partial<OverviewApi>): OverviewApi {
  return {
    loadInbox: vi.fn().mockResolvedValue(inbox),
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
  it("renders the stat strip, work queue, and timeline from the real action-inbox endpoint", async () => {
    renderBody();
    await screen.findByText(S.stat.approval);

    // stat strip: approval count 1 with the urgent sub-chip
    const approvalStat = screen.getByRole("button", {
      name: (n) => n.includes(S.stat.approval),
    });
    expect(within(approvalStat).getByText("1")).toBeInTheDocument();
    expect(screen.getByText(S.stat.urgent(1))).toBeInTheDocument();

    // queue rows. The approval is also due today, so it legitimately renders
    // again in the 오늘 timeline — scope the queue assertion to its region.
    const queue = within(screen.getByRole("region", { name: S.queueTitle }));
    expect(queue.getByText("Approve budget")).toBeInTheDocument();
    // timeline picks up the approval due today
    expect(screen.getByLabelText(S.timelineTitle)).toBeInTheDocument();
  });

  it("never renders a raw UUID as the row's ref badge (support tickets carry no human code)", async () => {
    renderBody({
      api: stubApi({
        loadInbox: vi.fn().mockResolvedValue({
          total: 1,
          items: [
            item({
              kind: "support",
              id: "support:1",
              title: "Reply ticket",
              ref: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
            }),
          ],
        }),
      }),
    });
    await screen.findByText("Reply ticket");
    expect(screen.queryByText("3fa85f64-5717-4562-b3fc-2c963f66afa6")).not.toBeInTheDocument();
  });

  it("drilling a stat filters the queue to that kind", async () => {
    const user = userEvent.setup();
    renderBody();
    const queue = within(
      await screen.findByRole("region", { name: S.queueTitle }),
    );

    await user.click(
      screen.getByRole("button", { name: (n) => n.includes(S.stat.dispatch) }),
    );
    expect(queue.getByText("Assign van")).toBeInTheDocument();
    // scoped to the queue: the approval stays in the 오늘 timeline, only the
    // queue is filtered to dispatch.
    expect(queue.queryByText("Approve budget")).not.toBeInTheDocument();
  });

  it("invokes onOpen with the item when a row action button is pressed", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderBody({ onOpen });
    await screen.findByRole("region", { name: S.queueTitle });

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
    await screen.findByRole("region", { name: S.queueTitle });
  });

  it("shows empty-queue copy when the filter matches nothing", async () => {
    const user = userEvent.setup();
    renderBody();
    await screen.findByRole("region", { name: S.queueTitle });
    // filter to the work stat (kind=work) — the fixture has none
    await user.click(
      screen.getByRole("button", { name: (n) => n.includes(S.stat.work) }),
    );
    expect(screen.getByText(S.empty.queue)).toBeInTheDocument();
  });
});
