import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { attendanceStrings as text } from "./attendanceStrings";
import {
  AttendanceTransportError,
  type AttendanceException,
  type AttendanceSummaryItem,
  type AttendanceTransport,
  type MonthCloseBoard,
  type Page,
  type Substitution,
  type Week52Board,
} from "./attendanceApi";
import type { AttendanceCapabilities } from "./attendanceCapabilities";
import { AttendanceScreen } from "./AttendanceScreen";

const NOW = () => new Date("2026-07-23T10:30:00+09:00");
const TODAY = "2026-07-23";

const manager: AttendanceCapabilities = {
  canRead: true,
  canRaise: true,
  canResolve: true,
  canSubstitute: true,
  canClose: true,
  canAckW52: true,
};
const denied: AttendanceCapabilities = {
  canRead: false,
  canRaise: false,
  canResolve: false,
  canSubstitute: false,
  canClose: false,
  canAckW52: false,
};

function page<T>(items: T[]): Page<T> {
  return { items, total: items.length, limit: 200, offset: 0 };
}

function exception(
  overrides: Partial<AttendanceException> = {},
): AttendanceException {
  return {
    id: "ex-1",
    code: "AT-0723-01",
    kind: "LATE",
    status: "OPEN",
    employee_id: "emp-1",
    employee_name: "김성호",
    team: "정비사업팀",
    work_date: TODAY,
    occurred_at: "2026-07-23T09:34:00+09:00",
    detail: "표준 출근 09:00 — 34분 지각",
    evidence: [],
    links: [],
    created_at: "2026-07-23T09:34:10+09:00",
    ...overrides,
  };
}

function substitution(overrides: Partial<Substitution> = {}): Substitution {
  return {
    id: "sub-1",
    site: "대원강업 상주",
    role: "경비",
    cover_date: TODAY,
    from_minutes: 690,
    to_minutes: 1080,
    covered_employee_id: "emp-2",
    covered_name: "최민석",
    reason_kind: "NO_SHOW",
    worker_name: "박대근",
    worker_type: "EMPLOYEE",
    status: "ASSIGNED",
    created_by: "actor-1",
    created_at: "2026-07-23T11:00:00+09:00",
    ...overrides,
  };
}

const exceptions = [
  exception(),
  exception({
    id: "ex-2",
    code: "AT-0723-02",
    kind: "NO_SHOW",
    employee_id: "emp-2",
    employee_name: "최민석",
    team: "경비팀",
    detail: "06:00 상주 미출근",
  }),
];

const records = {
  items: [
    {
      id: "rec-1",
      employee_id: "emp-1",
      employee_display_name: "김성호",
      kind: "CLOCK_IN" as const,
      occurred_at: "2026-07-23T09:34:00+09:00",
      work_date: TODAY,
      state_after: "CLOCKED_IN" as const,
      payroll_material_ref_id: "mat-1",
      payroll_link_status: "LINKED" as const,
      duplicate: false,
    },
  ],
};

const week52: Week52Board = {
  week_start: "2026-07-20",
  items: [
    {
      employee_id: "emp-1",
      name: "김성호",
      team: "정비사업팀",
      week_start: "2026-07-20",
      current_hours: 49.5,
      projected_hours: 53.4,
      tone: "DANGER",
      acked: false,
    },
  ],
};

const closes: MonthCloseBoard = {
  month: "2026-07",
  items: [
    {
      branch_scope: "코스",
      closed: false,
      open_exceptions: 2,
      pending_leave: 0,
    },
  ],
};

type TransportOverrides = Partial<AttendanceTransport>;

function transport(overrides: TransportOverrides = {}): AttendanceTransport {
  const pool: { items: AttendanceSummaryItem[] } = {
    items: [
      {
        user_id: "user-9",
        display_name: "박대근",
        arrivals: 12,
        departures: 12,
        last_kind: "DEPARTURE",
        last_event_at: "2026-07-22T18:01:00+09:00",
      },
    ],
  };
  return {
    listExceptions: vi.fn(async () => page(exceptions)),
    resolveException: vi.fn(async (id, input) =>
      exception({
        id,
        status: "RESOLVED",
        resolution: {
          action: "CONFIRM",
          reason: input.reason,
          actor: "actor-1",
          resolved_at: "2026-07-23T11:00:00+09:00",
        },
      }),
    ),
    listSubstitutions: vi.fn(async () => page<Substitution>([])),
    createSubstitution: vi.fn(async (input) => substitution(input)),
    cancelSubstitution: vi.fn(async () => substitution({ status: "CANCELLED" })),
    listCloses: vi.fn(async () => closes),
    preflightClose: vi.fn(async (month, branchScope) => ({
      month,
      branch_scope: branchScope,
      checks: [],
      can_close: true,
    })),
    confirmClose: vi.fn(async (month, branchScope) => ({
      id: "close-1",
      month,
      branch_scope: branchScope,
      checks: [],
      attested_by: "actor-1",
      attested_at: "2026-07-23T11:00:00+09:00",
      closed_at: "2026-07-23T11:00:00+09:00",
      amendments: [],
    })),
    listWeek52: vi.fn(async () => week52),
    ackWeek52: vi.fn(async () => ({ ...week52.items[0], acked: true })),
    listAttendanceRecords: vi.fn(async () => records),
    listAttendanceSummary: vi.fn(async () => pool),
    ...overrides,
  };
}

function renderScreen(
  attendanceTransport: AttendanceTransport,
  capabilities: AttendanceCapabilities = manager,
) {
  return render(
    <AttendanceScreen
      transport={attendanceTransport}
      branchId="branch-1"
      actorId="actor-1"
      capabilities={capabilities}
      sessionKey="session-a"
      now={NOW}
    />,
  );
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("AttendanceScreen", () => {
  it("requires a typed transport and denies before fetching when authority is absent", () => {
    const api = transport();
    renderScreen(api, denied);
    expect(screen.getByText(text.denied)).toBeVisible();
    expect(api.listExceptions).not.toHaveBeenCalled();
  });

  it("loads the selected month and exactly seven following dates for substitutions", async () => {
    window.sessionStorage.setItem("attendance:month", "2026-06");
    const api = transport({
      listExceptions: vi.fn(async () =>
        page([
          exception({
            id: "ex-historic",
            kind: "NO_SHOW",
            employee_id: "emp-historic",
            employee_name: "과거 결근자",
            work_date: "2026-06-03",
          }),
        ]),
      ),
      listSubstitutions: vi.fn(async () =>
        page([
          substitution({
            cover_date: "2026-06-03",
            covered_employee_id: "emp-historic",
            exception_id: "ex-historic",
          }),
        ]),
      ),
    });
    renderScreen(api);
    await waitFor(() => {
      expect(api.listSubstitutions).toHaveBeenCalledWith(
        { from_date: "2026-06-01", to_date: "2026-07-07" },
        expect.any(AbortSignal),
      );
    });
    const board = await screen.findByRole("region", { name: text.board.title });
    await userEvent.click(within(board).getByRole("button", { name: text.board.month }));
    const historicalDay = await within(board).findByTitle("2026-06-03");
    expect(historicalDay).toHaveClass("attendance__cell--covered");
    expect(within(board).queryByRole("button", { name: text.board.assignSub })).toBeNull();
  });

  it("renders operational data and closes the exception and substitution dialogs safely", async () => {
    const api = transport();
    renderScreen(api);
    const board = await screen.findByRole("region", { name: text.board.title });
    expect(await within(board).findByText("김성호")).toBeVisible();

    const exceptionsCard = screen.getByRole("region", { name: text.exceptions.title });
    const exceptionTrigger = await within(exceptionsCard).findByRole("button", {
      name: /김성호/,
    });
    await userEvent.click(exceptionTrigger);
    let dialog = await screen.findByRole("dialog", { name: text.exceptions.detailTitle });
    expect(dialog).toContainElement(document.activeElement);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(exceptionTrigger).toHaveFocus();

    const gapTrigger = await within(board).findByRole("button", { name: text.board.assignSub });
    await userEvent.click(gapTrigger);
    dialog = await screen.findByRole("dialog", { name: text.sub.title });
    expect(dialog).toContainElement(document.activeElement);
    const backdrop = dialog.parentElement;
    if (!backdrop) throw new Error("attendance dialog must render a backdrop");
    await userEvent.click(backdrop);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const closeCard = screen.getByRole("region", { name: text.closePanel.title });
    await userEvent.click(
      await within(closeCard).findByRole("button", {
        name: new RegExp(text.closePanel.blockedSuffix),
      }),
    );
    dialog = await screen.findByRole("dialog", { name: text.exceptions.detailTitle });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("uses the shared dialog for close preflight and restores the close trigger on Escape", async () => {
    const api = transport({
      listExceptions: vi.fn(async () =>
        page(exceptions.map((item) => ({ ...item, status: "RESOLVED" as const }))),
      ),
      listCloses: vi.fn(async () => ({
        month: "2026-07",
        items: [
          {
            branch_scope: "코스",
            closed: false,
            open_exceptions: 0,
            pending_leave: 0,
          },
        ],
      })),
    });
    renderScreen(api);
    const closeCard = await screen.findByRole("region", {
      name: text.closePanel.title,
    });
    const trigger = await within(closeCard).findByRole("button", {
      name: `코스 ${text.closePanel.confirmCta}`,
    });
    await userEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", {
      name: text.closePanel.preflightTitle,
    });
    expect(dialog).toContainElement(document.activeElement);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it("renders a transport authorization failure as a panel denial rather than fabricated data", async () => {
    const api = transport({
      listWeek52: vi.fn(async () => {
        throw new AttendanceTransportError("forbidden", 403);
      }),
    });
    renderScreen(api);
    const card = await screen.findByRole("region", { name: text.w52.title });
    expect(await within(card).findByText(text.panelDenied)).toBeVisible();
    expect(within(card).queryByRole("button", { name: text.retry })).toBeNull();
  });
});
