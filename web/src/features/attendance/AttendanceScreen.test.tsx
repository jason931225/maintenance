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

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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


const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function dialogFocusables(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
}

async function assertDialogKeyboardContract(
  name: string,
  opener: HTMLElement,
): Promise<void> {
  const dialog = await screen.findByRole("dialog", { name });
  const focusables = dialogFocusables(dialog);
  expect(focusables.length).toBeGreaterThan(0);
  expect(dialog).toContainElement(document.activeElement);

  // JSDOM does not compute layout, while the production primitive excludes
  // hidden controls via `offsetParent`. Make these rendered controls visible to
  // that branch so this test exercises the real Tab/Shift+Tab trap logic.
  for (const element of focusables) {
    Object.defineProperty(element, "offsetParent", {
      configurable: true,
      value: document.body,
    });
  }
  const first = focusables[0];
  const last = focusables.at(-1);
  if (!last) throw new Error("dialog must contain a last focusable control");
  last.focus();
  await userEvent.keyboard("{Tab}");
  expect(first).toHaveFocus();
  first.focus();
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  expect(last).toHaveFocus();

  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name })).toBeNull());
  expect(opener).toHaveFocus();

  await userEvent.click(opener);
  const reopened = await screen.findByRole("dialog", { name });
  const backdrop = reopened.parentElement;
  if (!backdrop) throw new Error("attendance dialog must render a backdrop");
  await userEvent.click(backdrop);
  await waitFor(() => expect(screen.queryByRole("dialog", { name })).toBeNull());
  expect(opener).toHaveFocus();
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
  it("shows loading and retries a non-403 typed transport error", async () => {
    let attempts = 0;
    const api = transport({
      listExceptions: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new AttendanceTransportError("attendance unavailable", 503);
        }
        return page(exceptions);
      }),
    });
    renderScreen(api);
    const card = await screen.findByRole("region", { name: text.exceptions.title });
    expect(await within(card).findByText("attendance unavailable")).toBeVisible();
    const retry = within(card).getByRole("button", { name: text.retry });
    await userEvent.click(retry);
    expect(await within(card).findByText("김성호")).toBeVisible();
    expect(api.listExceptions).toHaveBeenCalledWith(
      { month: "2026-07", limit: 200 },
      expect.any(AbortSignal),
    );
    expect(api.listExceptions).toHaveBeenCalledTimes(2);
  });

  it("renders loading while typed attendance reads are still pending", async () => {
    let release: ((value: Page<AttendanceException>) => void) | undefined;
    const pending = new Promise<Page<AttendanceException>>((resolve) => {
      release = resolve;
    });
    const api = transport({ listExceptions: vi.fn(() => pending) });
    renderScreen(api);
    const card = await screen.findByRole("region", { name: text.exceptions.title });
    expect(await within(card).findByText(text.loading)).toBeVisible();
    if (!release) throw new Error("test transport did not start");
    release(page(exceptions));
    expect(await within(card).findByText("김성호")).toBeVisible();
  });

  it("resolves an exception through the typed port and exposes mutation failure recovery", async () => {
    const resolveException = vi.fn(async (id: string, input: { reason: string }) =>
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
    );
    const api = transport({ resolveException });
    const successView = renderScreen(api);
    const card = await screen.findByRole("region", { name: text.exceptions.title });
    await userEvent.click(await within(card).findByRole("button", { name: /김성호/ }));
    const dialog = await screen.findByRole("dialog", { name: text.exceptions.detailTitle });
    await userEvent.type(within(dialog).getByLabelText(text.exceptions.reasonLabel), "출입 기록 확인");
    await userEvent.click(within(dialog).getByRole("button", { name: text.exceptions.resolveConfirm }));
    await waitFor(() => expect(resolveException).toHaveBeenCalledWith(
      "ex-1",
      { reason: "출입 기록 확인" },
      expect.any(AbortSignal),
    ));
    expect(await within(card).findByText(text.exceptions.resolved)).toBeVisible();
    successView.unmount();

    const failed = transport({
      resolveException: vi.fn(async () => {
        throw new AttendanceTransportError("resolve failed", 422);
      }),
    });
    const view = renderScreen(failed);
    const failedCard = await screen.findAllByRole("region", { name: text.exceptions.title });
    const latest = failedCard.at(-1);
    if (!latest) throw new Error("missing exception card");
    await userEvent.click(await within(latest).findByRole("button", { name: /김성호/ }));
    const failedDialog = await screen.findByRole("dialog", { name: text.exceptions.detailTitle });
    await userEvent.type(within(failedDialog).getByLabelText(text.exceptions.reasonLabel), "재시도");
    await userEvent.click(within(failedDialog).getByRole("button", { name: text.exceptions.resolveConfirm }));
    expect(await screen.findByText("resolve failed")).toBeVisible();
    expect(screen.getByRole("button", { name: text.retry })).toBeVisible();
    view.unmount();
  });

  it("creates a substitute through the typed port and keeps mutation failures visible", async () => {
    const createSubstitution = vi.fn(async (input: Parameters<AttendanceTransport["createSubstitution"]>[0]) =>
      substitution(input),
    );
    const api = transport({ createSubstitution });
    const successView = renderScreen(api);
    const board = await screen.findByRole("region", { name: text.board.title });
    await userEvent.click(await within(board).findByRole("button", { name: text.board.assignSub }));
    const dialog = await screen.findByRole("dialog", { name: text.sub.title });
    await userEvent.type(within(dialog).getByLabelText(text.sub.role), "경비");
    await userEvent.type(within(dialog).getByLabelText(text.sub.from), "11:30");
    await userEvent.type(within(dialog).getByLabelText(text.sub.to), "18:00");
    await userEvent.click(
      within(dialog).getByRole("button", { name: text.sub.assign }),
    );
    await waitFor(() => expect(createSubstitution).toHaveBeenCalledWith(
      expect.objectContaining({
        cover_date: TODAY,
        covered_employee_id: "emp-2",
        exception_id: "ex-2",
        from_minutes: 690,
        to_minutes: 1080,
        reason_kind: "NO_SHOW",
        worker_name: "박대근",
      }),
      expect.any(AbortSignal),
    ));
    expect(screen.queryByRole("dialog", { name: text.sub.title })).toBeNull();
    successView.unmount();

    const failingCreate = transport({
      createSubstitution: vi.fn(async () => {
        throw new AttendanceTransportError("substitute failed", 409);
      }),
    });
    const view = renderScreen(failingCreate);
    const boards = await screen.findAllByRole("region", { name: text.board.title });
    const latestBoard = boards.at(-1);
    if (!latestBoard) throw new Error("missing attendance board");
    await userEvent.click(await within(latestBoard).findByRole("button", { name: text.board.assignSub }));
    const failedDialog = await screen.findByRole("dialog", { name: text.sub.title });
    await userEvent.type(within(failedDialog).getByLabelText(text.sub.role), "경비");
    await userEvent.type(within(failedDialog).getByLabelText(text.sub.from), "11:30");
    await userEvent.type(within(failedDialog).getByLabelText(text.sub.to), "18:00");
    await userEvent.click(within(failedDialog).getByRole("button", { name: text.sub.assign }));
    expect(await screen.findByText("substitute failed")).toBeVisible();
    expect(screen.getByRole("dialog", { name: text.sub.title })).toBeVisible();
    view.unmount();
  });

  it("does not let a dismissed substitution refresh overwrite a newer month", async () => {
    const pendingCreate = deferred<Substitution>();
    const staleSubstitutions = deferred<Page<Substitution>>();
    const staleExceptions = deferred<Page<AttendanceException>>();
    let refreshAfterCreate = false;
    const listSubstitutions = vi.fn((range: { from_date: string }) => {
      if (range.from_date === "2026-07-01" && refreshAfterCreate) {
        return staleSubstitutions.promise;
      }
      return Promise.resolve(page<Substitution>([]));
    });
    const listExceptions = vi.fn((query: { month: string }) => {
      if (query.month === "2026-07" && refreshAfterCreate) {
        return staleExceptions.promise;
      }
      if (query.month === "2026-06") {
        return Promise.resolve(
          page([
            exception({
              id: "june-current",
              employee_name: "6월 현재 예외",
              work_date: "2026-06-12",
            }),
          ]),
        );
      }
      return Promise.resolve(page(exceptions));
    });
    const createSubstitution = vi.fn(() => pendingCreate.promise);
    const api = transport({
      createSubstitution,
      listExceptions,
      listSubstitutions,
    });
    renderScreen(api);

    const board = await screen.findByRole("region", { name: text.board.title });
    await userEvent.click(
      await within(board).findByRole("button", { name: text.board.assignSub }),
    );
    const dialog = await screen.findByRole("dialog", { name: text.sub.title });
    await userEvent.type(within(dialog).getByLabelText(text.sub.role), "경비");
    await userEvent.type(within(dialog).getByLabelText(text.sub.from), "11:30");
    await userEvent.type(within(dialog).getByLabelText(text.sub.to), "18:00");
    await userEvent.click(within(dialog).getByRole("button", { name: text.sub.assign }));
    await waitFor(() => expect(createSubstitution).toHaveBeenCalledTimes(1));

    await userEvent.click(
      within(dialog).getByRole("button", { name: text.sub.cancel }),
    );
    expect(screen.queryByRole("dialog", { name: text.sub.title })).toBeNull();

    refreshAfterCreate = true;
    pendingCreate.resolve(substitution({ id: "old-month-substitution" }));
    await waitFor(() => expect(listSubstitutions).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(listExceptions).toHaveBeenCalledTimes(2));

    await userEvent.click(
      within(board).getByRole("button", { name: text.board.month }),
    );
    await userEvent.click(
      within(board).getByRole("button", { name: text.board.prevMonth }),
    );
    expect(await within(board).findByText("2026년 6월")).toBeVisible();
    expect(
      (await screen.findAllByText("6월 현재 예외")).length,
    ).toBeGreaterThan(0);

    staleSubstitutions.resolve(
      page([
        substitution({
          id: "stale-substitution",
          worker_name: "7월 이전 대체",
        }),
      ]),
    );
    staleExceptions.resolve(
      page([
        exception({
          id: "stale-exception",
          employee_name: "7월 이전 예외",
        }),
      ]),
    );

    await waitFor(() => {
      expect(screen.getAllByText("6월 현재 예외").length).toBeGreaterThan(0);
      expect(screen.queryByText("7월 이전 예외")).toBeNull();
      expect(screen.queryByText("7월 이전 대체")).toBeNull();
    });
  });

  it("runs close preflight and confirmation through exact typed calls, including failures", async () => {
    let closed = false;
    const closeBoard = () => ({
      month: "2026-07",
      items: closed
        ? [{ ...closes.items[0], closed: true, open_exceptions: 0 }]
        : [{ ...closes.items[0], open_exceptions: 0 }],
    });
    const preflightClose = vi.fn(async (month: string, branchScope: string) => ({
      month,
      branch_scope: branchScope,
      checks: [{ key: "예외", ok: true }],
      can_close: true,
    }));
    const confirmClose = vi.fn(async (month: string, branchScope: string) => {
      closed = true;
      return {
        id: "close-1",
        month,
        branch_scope: branchScope,
        checks: [],
        attested_by: "actor-1",
        attested_at: "2026-07-23T11:00:00+09:00",
        closed_at: "2026-07-23T11:00:00+09:00",
        amendments: [],
      };
    });
    const api = transport({
      listExceptions: vi.fn(async () => page(exceptions.map((item) => ({ ...item, status: "RESOLVED" as const })))),
      listCloses: vi.fn(async () => closeBoard()),
      preflightClose,
      confirmClose,
    });
    const successView = renderScreen(api);
    const card = await screen.findByRole("region", { name: text.closePanel.title });
    await userEvent.click(await within(card).findByRole("button", { name: `코스 ${text.closePanel.confirmCta}` }));
    const dialog = await screen.findByRole("dialog", { name: text.closePanel.preflightTitle });
    await userEvent.click(within(dialog).getByLabelText(text.closePanel.attest));
    await userEvent.click(within(dialog).getByRole("button", { name: `코스 ${text.closePanel.confirmCta}` }));
    await waitFor(() => expect(preflightClose).toHaveBeenCalledWith("2026-07", "코스", expect.any(AbortSignal)));
    await waitFor(() => expect(confirmClose).toHaveBeenCalledWith("2026-07", "코스", expect.any(AbortSignal)));
    expect(await within(card).findByText(text.closePanel.doneBanner)).toBeVisible();
    successView.unmount();
    closed = false;

    const failing = transport({
      listExceptions: vi.fn(async () => page(exceptions.map((item) => ({ ...item, status: "RESOLVED" as const })))),
      listCloses: vi.fn(async () => closeBoard()),
      preflightClose: vi.fn(async () => {
        throw new AttendanceTransportError("preflight failed", 409);
      }),
    });
    const view = renderScreen(failing);
    const cards = await screen.findAllByRole("region", { name: text.closePanel.title });
    const latest = cards.at(-1);
    if (!latest) throw new Error("missing close panel");
    await userEvent.click(await within(latest).findByRole("button", { name: `코스 ${text.closePanel.confirmCta}` }));
    expect(await screen.findByText("preflight failed")).toBeVisible();
    view.unmount();
  });

  it("ignores a close preflight that resolves after the selected month changes", async () => {
    const pendingPreflight = deferred<{
      month: string;
      branch_scope: string;
      checks: [];
      can_close: true;
    }>();
    const preflightClose = vi.fn(() => pendingPreflight.promise);
    const confirmClose = vi.fn();
    const api = transport({
      listExceptions: vi.fn(() =>
        Promise.resolve(
          page(
            exceptions.map((item) => ({
              ...item,
              status: "RESOLVED" as const,
            })),
          ),
        ),
      ),
      listCloses: vi.fn((month: string) =>
        Promise.resolve({
          month,
          items: [{ ...closes.items[0], open_exceptions: 0 }],
        }),
      ),
      preflightClose,
      confirmClose,
    });
    renderScreen(api);

    const closeCard = await screen.findByRole("region", {
      name: text.closePanel.title,
    });
    await userEvent.click(
      await within(closeCard).findByRole("button", {
        name: `코스 ${text.closePanel.confirmCta}`,
      }),
    );
    await waitFor(() =>
      expect(preflightClose).toHaveBeenCalledWith(
        "2026-07",
        "코스",
        expect.any(AbortSignal),
      ),
    );

    const board = screen.getByRole("region", { name: text.board.title });
    await userEvent.click(
      within(board).getByRole("button", { name: text.board.month }),
    );
    await userEvent.click(
      within(board).getByRole("button", { name: text.board.prevMonth }),
    );
    expect(await within(board).findByText("2026년 6월")).toBeVisible();

    pendingPreflight.resolve({
      month: "2026-07",
      branch_scope: "코스",
      checks: [],
      can_close: true,
    });

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: text.closePanel.preflightTitle }),
      ).toBeNull(),
    );
    expect(confirmClose).not.toHaveBeenCalled();
  });

  it("retains an actionable close preflight after confirmation rejects", async () => {
    const confirmClose = vi.fn(() =>
      Promise.reject(new AttendanceTransportError("close failed", 409)),
    );
    const api = transport({
      listExceptions: vi.fn(() =>
        Promise.resolve(
          page(
            exceptions.map((item) => ({
              ...item,
              status: "RESOLVED" as const,
            })),
          ),
        ),
      ),
      listCloses: vi.fn(() =>
        Promise.resolve({
          month: "2026-07",
          items: [{ ...closes.items[0], open_exceptions: 0 }],
        }),
      ),
      confirmClose,
    });
    renderScreen(api);

    const card = await screen.findByRole("region", {
      name: text.closePanel.title,
    });
    await userEvent.click(
      await within(card).findByRole("button", {
        name: `코스 ${text.closePanel.confirmCta}`,
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: text.closePanel.preflightTitle,
    });
    await userEvent.click(within(dialog).getByLabelText(text.closePanel.attest));
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: `코스 ${text.closePanel.confirmCta}`,
      }),
    );

    expect(await screen.findByText("close failed")).toBeVisible();
    expect(
      screen.getByRole("dialog", { name: text.closePanel.preflightTitle }),
    ).toBeVisible();
    expect(
      within(card).queryByText(text.closePanel.doneBanner),
    ).toBeNull();
    expect(screen.getByRole("button", { name: text.retry })).toBeVisible();
    expect(confirmClose).toHaveBeenCalledWith(
      "2026-07",
      "코스",
      expect.any(AbortSignal),
    );
  });

  it("acknowledges 52-hour risk through the typed port and surfaces failures", async () => {
    const ackWeek52 = vi.fn(async () => ({ ...week52.items[0], acked: true }));
    const api = transport({ ackWeek52 });
    const successView = renderScreen(api);
    const card = await screen.findByRole("region", { name: text.w52.title });
    await userEvent.click(await within(card).findByRole("button", { name: text.w52.adjust }));
    await waitFor(() => expect(ackWeek52).toHaveBeenCalledWith("emp-1", "2026-07-20", expect.any(AbortSignal)));
    expect(await within(card).findByText(text.w52.requested)).toBeVisible();
    successView.unmount();

    const failing = transport({
      ackWeek52: vi.fn(async () => {
        throw new AttendanceTransportError("ack failed", 409);
      }),
    });
    const view = renderScreen(failing);
    const cards = await screen.findAllByRole("region", { name: text.w52.title });
    const latest = cards.at(-1);
    if (!latest) throw new Error("missing 52-hour panel");
    await userEvent.click(await within(latest).findByRole("button", { name: text.w52.adjust }));
    expect(await screen.findByText("ack failed")).toBeVisible();
    view.unmount();
  });

  it("suppresses every mutation for read-only authority", async () => {
    const reader: AttendanceCapabilities = {
      ...manager,
      canRaise: false,
      canResolve: false,
      canSubstitute: false,
      canClose: false,
      canAckW52: false,
    };
    const api = transport();
    renderScreen(api, reader);
    const board = await screen.findByRole("region", { name: text.board.title });
    expect(within(board).getByText("김성호")).toBeVisible();
    expect(screen.queryByRole("button", { name: text.board.assignSub })).toBeNull();
    expect(screen.queryByRole("button", { name: text.w52.adjust })).toBeNull();
    expect(screen.queryByRole("button", { name: new RegExp(text.closePanel.blockedSuffix) })).toBeNull();
  });

  it("uses the shared focus-trapped dialog contract for exception, substitution, and preflight", async () => {
    const exceptionView = renderScreen(transport());
    const exceptionCard = await screen.findByRole("region", { name: text.exceptions.title });
    const exceptionTrigger = await within(exceptionCard).findByRole("button", { name: /김성호/ });
    await userEvent.click(exceptionTrigger);
    await assertDialogKeyboardContract(text.exceptions.detailTitle, exceptionTrigger);
    exceptionView.unmount();

    const substitutionView = renderScreen(transport());
    const board = await screen.findByRole("region", { name: text.board.title });
    const substitutionTrigger = await within(board).findByRole("button", { name: text.board.assignSub });
    await userEvent.click(substitutionTrigger);
    await assertDialogKeyboardContract(text.sub.title, substitutionTrigger);
    substitutionView.unmount();

    const preflightView = renderScreen(
      transport({
        listExceptions: vi.fn(async () => page(exceptions.map((item) => ({ ...item, status: "RESOLVED" as const })))),
        listCloses: vi.fn(async () => ({
          month: "2026-07",
          items: [{ ...closes.items[0], open_exceptions: 0 }],
        })),
      }),
    );
    const closeCard = await screen.findByRole("region", { name: text.closePanel.title });
    const closeTrigger = await within(closeCard).findByRole("button", { name: `코스 ${text.closePanel.confirmCta}` });
    await userEvent.click(closeTrigger);
    await assertDialogKeyboardContract(text.closePanel.preflightTitle, closeTrigger);
    preflightView.unmount();
  });

});
