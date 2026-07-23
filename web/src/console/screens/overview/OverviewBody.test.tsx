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

  it("shows an aggregate footer under the queue and timeline panels (verdict r13 overview lower region sparse)", async () => {
    renderBody({
      api: stubApi({
        loadInbox: vi.fn().mockResolvedValue({
          total: 3,
          items: [
            // `due` is exactly NOW so it lands on today regardless of the
            // test runner's local timezone (a different-hour ISO string can
            // roll to the adjacent local calendar day and flake).
            item({ kind: "approval", id: "approval:1", title: "Approve budget", due: NOW.toISOString() }),
            item({ kind: "dispatch", id: "dispatch:1", title: "Assign van" }),
            item({ kind: "support", id: "support:1", title: "Reply ticket" }),
          ],
        }),
      }),
    });
    await screen.findByText(S.stat.approval);

    const queue = within(screen.getByRole("region", { name: S.queueTitle }));
    // 3 fixture items, none filtered out by the default "all" chip.
    expect(queue.getByText(S.footer.shown(3, 3))).toBeInTheDocument();

    const timeline = within(screen.getByLabelText(S.timelineTitle));
    // Only the approval item carries a `due` timestamp matching NOW's date.
    expect(timeline.getByText(S.footer.shown(1, 3))).toBeInTheDocument();
  });

  it("gives 오늘 agenda rows owner parity with the queue — site and person, not person alone (verdict r15)", async () => {
    renderBody({
      api: stubApi({
        loadInbox: vi.fn().mockResolvedValue({
          total: 1,
          items: [
            item({
              kind: "approval",
              id: "approval:9",
              title: "급여 소급분 검증 요청",
              due: NOW.toISOString(),
              site: "경영지원팀",
              who: "@김성아",
            }),
          ],
        }),
      }),
    });
    const timeline = within(await screen.findByLabelText(S.timelineTitle));
    // the agenda row now surfaces the owner site (team) and the person, matching
    // the 처리 대기 row's meta — previously only the person showed.
    expect(timeline.getByText("경영지원팀")).toBeInTheDocument();
    expect(timeline.getByText("@김성아")).toBeInTheDocument();
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

  it("leads a code-only row with its kind label and demotes the code to meta (§4-18)", async () => {
    renderBody({
      api: stubApi({
        loadInbox: vi.fn().mockResolvedValue({
          total: 1,
          items: [
            // work/dispatch rows carry only a request_no as their title (===ref)
            item({
              kind: "work",
              id: "work:1",
              title: "20260710-004",
              ref: "20260710-004",
              site: "인천 제2물류센터",
            }),
          ],
        }),
      }),
    });
    const queue = within(await screen.findByRole("region", { name: S.queueTitle }));
    // primary title is the human site, never the raw code…
    expect(queue.getByText("인천 제2물류센터")).toBeInTheDocument();
    // …and the code sits on the meta line, not the title.
    expect(queue.getByText("20260710-004")).toBeInTheDocument();
    // the raw code is gone from the title slot entirely (only the meta chip has it)
    expect(queue.queryByText("20260710-004 · 인천 제2물류센터")).not.toBeInTheDocument();
  });

  it("falls back to the kind label when a code-only row has no site (§4-18)", async () => {
    renderBody({
      api: stubApi({
        loadInbox: vi.fn().mockResolvedValue({
          total: 1,
          items: [
            item({ kind: "dispatch", id: "dispatch:2", title: "20260710-009", ref: "20260710-009" }),
          ],
        }),
      }),
    });
    const queue = within(await screen.findByRole("region", { name: S.queueTitle }));
    // no site → the type chip and the title both read the kind label; assert both.
    expect(queue.getAllByText(S.chip.dispatch).length).toBeGreaterThanOrEqual(2);
    expect(queue.getByText("20260710-009")).toBeInTheDocument();
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

  it("supports J/K and arrow-key traversal of queue actions, then opens the focused row", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderBody({ onOpen });
    const queue = within(await screen.findByRole("region", { name: S.queueTitle }));
    const approval = queue.getByRole("button", { name: S.action.approval });
    const dispatch = queue.getByRole("button", { name: S.action.dispatch });

    approval.focus();
    await user.keyboard("j");
    expect(dispatch).toHaveFocus();

    await user.keyboard("{ArrowUp}");
    expect(approval).toHaveFocus();

    await user.keyboard("{Enter}");
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

  it("shows the 출근 chip from the caller's latest attendance today, and none without it", async () => {
    // Same local-day build the deriver uses, so the compare is TZ-independent.
    const pad = (n: number) => String(n).padStart(2, "0");
    const workDate = `${String(NOW.getFullYear())}-${pad(NOW.getMonth() + 1)}-${pad(NOW.getDate())}`;
    renderBody({
      api: stubApi({
        loadMyAttendance: vi.fn().mockResolvedValue([
          {
            id: "att-1",
            employee_id: "emp-1",
            employee_display_name: "Kim",
            kind: "CLOCK_IN",
            occurred_at: "2026-07-03T08:52:00Z",
            work_date: workDate,
            state_after: "CLOCKED_IN",
            payroll_material_ref_id: "ref-1",
            payroll_link_status: "LINKED",
            duplicate: false,
          },
        ]),
      }),
    });
    // the chip is a status role carrying the clock-in label
    const chip = await screen.findByText((t) => t.startsWith(S.punch.in("").trim()));
    expect(chip).toBeInTheDocument();
  });

  it("renders no 출근 chip when the attendance read soft-fails to empty", async () => {
    renderBody({
      api: stubApi({ loadMyAttendance: vi.fn().mockResolvedValue([]) }),
    });
    await screen.findByRole("region", { name: S.queueTitle });
    expect(
      screen.queryByText((t) => t.startsWith(S.punch.in("").trim())),
    ).not.toBeInTheDocument();
  });
});
