import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { attendanceStrings as text } from "../../i18n/attendance";
import {
  AttendanceTransportError,
  type AttendanceException,
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
  const candidates = {
    items: [
      {
        employee_id: "worker-9",
        employee_name: "박대근",
        branch_id: "branch-1",
      },
    ],
  };
  return {
    listExceptions: vi.fn<AttendanceTransport["listExceptions"]>(() =>
      Promise.resolve(page(exceptions)),
    ),
    createException: vi.fn<AttendanceTransport["createException"]>((input) =>
      Promise.resolve(exception({ ...input, id: "raised-exception" })),
    ),
    resolveException: vi.fn<AttendanceTransport["resolveException"]>(
      (id, input) =>
        Promise.resolve(
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
    ),
    listSubstitutions: vi.fn<AttendanceTransport["listSubstitutions"]>(() =>
      Promise.resolve(page<Substitution>([])),
    ),
    createSubstitution: vi.fn<AttendanceTransport["createSubstitution"]>(
      (input) => Promise.resolve(substitution(input)),
    ),
    cancelSubstitution: vi.fn<AttendanceTransport["cancelSubstitution"]>(() =>
      Promise.resolve(substitution({ status: "CANCELLED" })),
    ),
    listCloses: vi.fn<AttendanceTransport["listCloses"]>(() =>
      Promise.resolve(closes),
    ),
    preflightClose: vi.fn<AttendanceTransport["preflightClose"]>(
      (month, branchScope) =>
        Promise.resolve({
          month,
          branch_scope: branchScope,
          checks: [],
          can_close: true,
        }),
    ),
    confirmClose: vi.fn<AttendanceTransport["confirmClose"]>(
      (month, branchScope) =>
        Promise.resolve({
          id: "close-1",
          month,
          branch_scope: branchScope,
          checks: [],
          attested_by: "actor-1",
          attested_at: "2026-07-23T11:00:00+09:00",
          closed_at: "2026-07-23T11:00:00+09:00",
          amendments: [],
        }),
    ),
    addCloseAmendment: vi.fn<AttendanceTransport["addCloseAmendment"]>(() =>
      Promise.resolve({
        id: "amendment-1",
        reason: "corrected",
        actor: "actor-1",
        created_at: "2026-07-23T11:00:00+09:00",
      }),
    ),
    listWeek52: vi.fn<AttendanceTransport["listWeek52"]>(() =>
      Promise.resolve(week52),
    ),
    ackWeek52: vi.fn<AttendanceTransport["ackWeek52"]>(() =>
      Promise.resolve({ ...week52.items[0], acked: true }),
    ),
    listAttendanceRecords: vi.fn<AttendanceTransport["listAttendanceRecords"]>(
      () => Promise.resolve(records),
    ),
    listSubstitutionCandidates: vi.fn<
      AttendanceTransport["listSubstitutionCandidates"]
    >(() => Promise.resolve(page(candidates.items))),
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
  const activeElement = document.activeElement;
  if (!(
    activeElement instanceof HTMLElement || activeElement instanceof SVGElement
  )) {
    throw new Error("dialog must receive an element focus target");
  }
  expect(dialog).toContainElement(activeElement);

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
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name })).toBeNull();
  });
  expect(opener).toHaveFocus();

  await userEvent.click(opener);
  const reopened = await screen.findByRole("dialog", { name });
  const backdrop = reopened.parentElement;
  if (!backdrop) throw new Error("attendance dialog must render a backdrop");
  fireEvent.mouseDown(backdrop);
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name })).toBeNull();
  });
  expect(opener).toHaveFocus();
}

async function assertBusyDialogCannotClose(
  dialog: HTMLElement,
  name: string,
  closeButton: string,
): Promise<void> {
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("dialog", { name })).toBeVisible();

  const backdrop = dialog.parentElement;
  if (!backdrop) throw new Error("attendance dialog must render a backdrop");
  fireEvent.mouseDown(backdrop);
  expect(screen.getByRole("dialog", { name })).toBeVisible();

  await userEvent.click(
    within(dialog).getByRole("button", { name: closeButton }),
  );
  expect(screen.getByRole("dialog", { name })).toBeVisible();
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("AttendanceScreen", () => {
  it("requires a typed transport and denies before fetching when authority is absent", () => {
    const listExceptions = vi.fn<AttendanceTransport["listExceptions"]>(() =>
      Promise.resolve(page(exceptions)),
    );
    const api = transport({ listExceptions });
    renderScreen(api, denied);
    expect(screen.queryByText(text.denied)).toBeNull();
    expect(listExceptions).not.toHaveBeenCalled();
  });

  it("loads the selected month and exactly seven following dates for substitutions", async () => {
    window.sessionStorage.setItem("attendance:month", "2026-06");
    const listSubstitutions = vi.fn<AttendanceTransport["listSubstitutions"]>(
      () =>
        Promise.resolve(
          page([
            substitution({
              cover_date: "2026-06-03",
              covered_employee_id: "emp-historic",
              exception_id: "ex-historic",
            }),
          ]),
        ),
    );
    const api = transport({
      listExceptions: vi.fn<AttendanceTransport["listExceptions"]>(() =>
        Promise.resolve(
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
      ),
      listSubstitutions,
    });
    renderScreen(api);
    await waitFor(() => {
      expect(listSubstitutions).toHaveBeenCalledWith(
        { from_date: "2026-06-01", to_date: "2026-07-07" },
        expect.any(AbortSignal),
      );
    });
    const board = await screen.findByRole("region", { name: text.board.title });
    await userEvent.click(
      within(board).getByRole("button", { name: text.board.month }),
    );
    const historicalDay = await within(board).findByTitle("2026-06-03");
    expect(historicalDay).toHaveClass("attendance__cell--covered");
    expect(
      within(board).queryByRole("button", { name: text.board.assignSub }),
    ).toBeNull();
  });

  it("does not expose the month summary as an incomplete table row", async () => {
    renderScreen(transport());
    const board = await screen.findByRole("region", { name: text.board.title });
    await userEvent.click(
      within(board).getByRole("button", { name: text.board.month }),
    );

    expect(screen.queryByRole("row")).toBeNull();
  });

  it("renders a transport authorization failure as a panel denial rather than fabricated data", async () => {
    const api = transport({
      listWeek52: vi.fn<AttendanceTransport["listWeek52"]>(() =>
        Promise.reject(new AttendanceTransportError("forbidden", 403)),
      ),
    });
    renderScreen(api);
    const card = await screen.findByRole("region", { name: text.w52.title });
    expect(await within(card).findByText(text.panelDenied)).toBeVisible();
    expect(within(card).queryByRole("button", { name: text.retry })).toBeNull();
  });
  it("shows loading and retries a non-403 typed transport error", async () => {
    let attempts = 0;
    const listExceptions = vi.fn<AttendanceTransport["listExceptions"]>(() => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(
          new AttendanceTransportError("attendance unavailable", 503),
        );
      }
      return Promise.resolve(page(exceptions));
    });
    const api = transport({ listExceptions });
    renderScreen(api);
    const card = await screen.findByRole("region", {
      name: text.exceptions.title,
    });
    expect(
      await within(card).findByText("attendance unavailable"),
    ).toBeVisible();
    const retry = within(card).getByRole("button", { name: text.retry });
    await userEvent.click(retry);
    expect(await within(card).findByText("김성호")).toBeVisible();
    expect(listExceptions).toHaveBeenCalledWith(
      { month: "2026-07", limit: 200 },
      expect.any(AbortSignal),
    );
    expect(listExceptions).toHaveBeenCalledTimes(2);
  });

  it("renders loading while typed attendance reads are still pending", async () => {
    let release: ((value: Page<AttendanceException>) => void) | undefined;
    const pending = new Promise<Page<AttendanceException>>((resolve) => {
      release = resolve;
    });
    const api = transport({ listExceptions: vi.fn(() => pending) });
    renderScreen(api);
    const card = await screen.findByRole("region", {
      name: text.exceptions.title,
    });
    expect(await within(card).findByText(text.loading)).toBeVisible();
    if (!release) throw new Error("test transport did not start");
    release(page(exceptions));
    expect(await within(card).findByText("김성호")).toBeVisible();
  });

  it("resolves an exception through the typed port and exposes mutation failure recovery", async () => {
    const resolveException = vi.fn<AttendanceTransport["resolveException"]>(
      (id, input) =>
        Promise.resolve(
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
    );
    const api = transport({ resolveException });
    const successView = renderScreen(api);
    const card = await screen.findByRole("region", {
      name: text.exceptions.title,
    });
    await userEvent.click(
      await within(card).findByRole("button", { name: /김성호/ }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: text.exceptions.detailTitle,
    });
    await userEvent.type(
      within(dialog).getByLabelText(text.exceptions.reasonLabel),
      "출입 기록 확인",
    );
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: text.exceptions.resolveConfirm,
      }),
    );
    await waitFor(() => {
      expect(resolveException).toHaveBeenCalledWith(
        "ex-1",
        { action: "CONFIRM", reason: "출입 기록 확인" },
        expect.any(AbortSignal),
      );
    });
    expect(
      await within(card).findByText(text.exceptions.resolved),
    ).toBeVisible();
    successView.unmount();

    const failed = transport({
      resolveException: vi.fn<AttendanceTransport["resolveException"]>(() =>
        Promise.reject(new AttendanceTransportError("resolve failed", 422)),
      ),
    });
    const view = renderScreen(failed);
    const failedCard = await screen.findAllByRole("region", {
      name: text.exceptions.title,
    });
    const latest = failedCard.at(-1);
    if (!latest) throw new Error("missing exception card");
    await userEvent.click(
      await within(latest).findByRole("button", { name: /김성호/ }),
    );
    const failedDialog = await screen.findByRole("dialog", {
      name: text.exceptions.detailTitle,
    });
    await userEvent.type(
      within(failedDialog).getByLabelText(text.exceptions.reasonLabel),
      "재시도",
    );
    await userEvent.click(
      within(failedDialog).getByRole("button", {
        name: text.exceptions.resolveConfirm,
      }),
    );
    expect(await screen.findByText("resolve failed")).toBeVisible();
    expect(screen.getByRole("button", { name: text.retry })).toBeVisible();
    view.unmount();
  });

  it("keeps an exception dialog open while resolution is pending", async () => {
    const pendingResolve = deferred<AttendanceException>();
    const api = transport({
      resolveException: vi.fn<AttendanceTransport["resolveException"]>(
        () => pendingResolve.promise,
      ),
    });
    renderScreen(api);
    const card = await screen.findByRole("region", {
      name: text.exceptions.title,
    });
    await userEvent.click(
      await within(card).findByRole("button", { name: /김성호/ }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: text.exceptions.detailTitle,
    });
    await userEvent.type(
      within(dialog).getByLabelText(text.exceptions.reasonLabel),
      "출입 기록 확인",
    );
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: text.exceptions.resolveConfirm,
      }),
    );

    await assertBusyDialogCannotClose(
      dialog,
      text.exceptions.detailTitle,
      text.exceptions.close,
    );
    pendingResolve.resolve(exception({ id: "ex-1", status: "RESOLVED" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: text.exceptions.detailTitle }),
      ).toBeNull();
    });
  });

  it("creates a substitute through the typed port and keeps mutation failures visible", async () => {
    const createSubstitution = vi.fn<AttendanceTransport["createSubstitution"]>(
      (input) => Promise.resolve(substitution(input)),
    );
    const api = transport({ createSubstitution });
    const successView = renderScreen(api);
    const board = await screen.findByRole("region", { name: text.board.title });
    await userEvent.click(
      await within(board).findByRole("button", { name: text.board.assignSub }),
    );
    const dialog = await screen.findByRole("dialog", { name: text.sub.title });
    await userEvent.type(within(dialog).getByLabelText(text.sub.role), "경비");
    await userEvent.type(within(dialog).getByLabelText(text.sub.from), "11:30");
    await userEvent.type(within(dialog).getByLabelText(text.sub.to), "18:00");
    await userEvent.click(
      await within(dialog).findByRole("button", { name: text.sub.assign }),
    );
    await waitFor(() => {
      expect(createSubstitution).toHaveBeenCalledWith(
        expect.objectContaining({
          cover_date: TODAY,
          covered_employee_id: "emp-2",
          exception_id: "ex-2",
          from_minutes: 690,
          to_minutes: 1080,
          reason_kind: "NO_SHOW",
          worker_employee_id: "worker-9",
        }),
        expect.any(AbortSignal),
      );
    });
    expect(screen.queryByRole("dialog", { name: text.sub.title })).toBeNull();
    successView.unmount();

    const failingCreate = transport({
      createSubstitution: vi.fn<AttendanceTransport["createSubstitution"]>(() =>
        Promise.reject(new AttendanceTransportError("substitute failed", 409)),
      ),
    });
    const view = renderScreen(failingCreate);
    const boards = await screen.findAllByRole("region", {
      name: text.board.title,
    });
    const latestBoard = boards.at(-1);
    if (!latestBoard) throw new Error("missing attendance board");
    await userEvent.click(
      await within(latestBoard).findByRole("button", {
        name: text.board.assignSub,
      }),
    );
    const failedDialog = await screen.findByRole("dialog", {
      name: text.sub.title,
    });
    await userEvent.type(
      within(failedDialog).getByLabelText(text.sub.role),
      "경비",
    );
    await userEvent.type(
      within(failedDialog).getByLabelText(text.sub.from),
      "11:30",
    );
    await userEvent.type(
      within(failedDialog).getByLabelText(text.sub.to),
      "18:00",
    );
    await userEvent.click(
      await within(failedDialog).findByRole("button", {
        name: text.sub.assign,
      }),
    );
    expect(await screen.findByText("substitute failed")).toBeVisible();
    expect(screen.getByRole("dialog", { name: text.sub.title })).toBeVisible();
    view.unmount();
  });

  it("keeps a substitution dialog open while assignment is pending", async () => {
    const pendingCreate = deferred<Substitution>();
    const api = transport({
      createSubstitution: vi.fn<AttendanceTransport["createSubstitution"]>(
        () => pendingCreate.promise,
      ),
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
    await userEvent.click(
      await within(dialog).findByRole("button", { name: text.sub.assign }),
    );

    await assertBusyDialogCannotClose(dialog, text.sub.title, text.sub.cancel);
    pendingCreate.resolve(substitution({ id: "pending-substitution" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: text.sub.title })).toBeNull();
    });
  });

  it("disables direct month controls while a substitution mutation is pending", async () => {
    const pendingCreate = deferred<Substitution>();
    const createSubstitution = vi.fn<AttendanceTransport["createSubstitution"]>(
      () => pendingCreate.promise,
    );
    renderScreen(transport({ createSubstitution }));

    const board = await screen.findByRole("region", { name: text.board.title });
    await userEvent.click(
      within(board).getByRole("button", { name: text.board.month }),
    );
    await within(board).findByRole("button", { name: text.board.prevMonth });
    await userEvent.click(
      within(board).getByRole("button", { name: text.board.day }),
    );
    await userEvent.click(
      await within(board).findByRole("button", { name: text.board.assignSub }),
    );
    const dialog = await screen.findByRole("dialog", { name: text.sub.title });
    await userEvent.type(within(dialog).getByLabelText(text.sub.role), "경비");
    await userEvent.type(within(dialog).getByLabelText(text.sub.from), "11:30");
    await userEvent.type(within(dialog).getByLabelText(text.sub.to), "18:00");
    await userEvent.click(
      await within(dialog).findByRole("button", { name: text.sub.assign }),
    );
    await waitFor(() => {
      expect(createSubstitution).toHaveBeenCalledTimes(1);
    });

    await userEvent.click(
      within(board).getByRole("button", { name: text.board.month }),
    );
    const previousMonth = within(board).getByRole("button", {
      name: text.board.prevMonth,
    });
    expect(previousMonth).toBeDisabled();
    await userEvent.click(previousMonth);
    expect(within(board).getByText("2026년 7월")).toBeVisible();
    expect(screen.getByRole("dialog", { name: text.sub.title })).toBeVisible();

    pendingCreate.resolve(substitution({ id: "pending-substitution" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: text.sub.title })).toBeNull();
    });
  });

  it("allows month navigation after a substitution mutation settles", async () => {
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
    await userEvent.click(
      await within(dialog).findByRole("button", { name: text.sub.assign }),
    );
    await waitFor(() => {
      expect(createSubstitution).toHaveBeenCalledTimes(1);
    });

    refreshAfterCreate = true;
    pendingCreate.resolve(substitution({ id: "old-month-substitution" }));
    await waitFor(() => {
      expect(listSubstitutions).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(listExceptions).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByRole("dialog", { name: text.sub.title })).toBeNull();

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
      expect(screen.getByText("7월 이전 예외")).toBeVisible();
      expect(screen.getByText("7월 이전 대체")).toBeVisible();
    });
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
  });

  it("runs close preflight and confirmation through exact typed calls, including failures", async () => {
    let closed = false;
    const closeBoard = () => ({
      month: "2026-07",
      items: closed
        ? [{ ...closes.items[0], closed: true, open_exceptions: 0 }]
        : [{ ...closes.items[0], open_exceptions: 0 }],
    });
    const preflightClose = vi.fn<AttendanceTransport["preflightClose"]>(
      (month, branchScope) =>
        Promise.resolve({
          month,
          branch_scope: branchScope,
          checks: [{ key: "예외", ok: true }],
          can_close: true,
        }),
    );
    const confirmClose = vi.fn<AttendanceTransport["confirmClose"]>(
      (month, branchScope) => {
        closed = true;
        return Promise.resolve({
          id: "close-1",
          month,
          branch_scope: branchScope,
          checks: [],
          attested_by: "actor-1",
          attested_at: "2026-07-23T11:00:00+09:00",
          closed_at: "2026-07-23T11:00:00+09:00",
          amendments: [],
        });
      },
    );
    const api = transport({
      listExceptions: vi.fn<AttendanceTransport["listExceptions"]>(() =>
        Promise.resolve(
          page(
            exceptions.map((item) => ({
              ...item,
              status: "RESOLVED" as const,
            })),
          ),
        ),
      ),
      listCloses: vi.fn<AttendanceTransport["listCloses"]>(() =>
        Promise.resolve(closeBoard()),
      ),
      preflightClose,
      confirmClose,
    });
    const successView = renderScreen(api);
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
    await userEvent.click(
      within(dialog).getByLabelText(text.closePanel.attest),
    );
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: `코스 ${text.closePanel.confirmCta}`,
      }),
    );
    await waitFor(() => {
      expect(preflightClose).toHaveBeenCalledWith(
        "2026-07",
        "코스",
        expect.any(AbortSignal),
      );
    });
    await waitFor(() => {
      expect(confirmClose).toHaveBeenCalledWith(
        "2026-07",
        "코스",
        expect.any(AbortSignal),
      );
    });
    expect(
      await within(card).findByText(text.closePanel.doneBanner),
    ).toBeVisible();
    successView.unmount();
    closed = false;

    const failing = transport({
      listExceptions: vi.fn<AttendanceTransport["listExceptions"]>(() =>
        Promise.resolve(
          page(
            exceptions.map((item) => ({
              ...item,
              status: "RESOLVED" as const,
            })),
          ),
        ),
      ),
      listCloses: vi.fn<AttendanceTransport["listCloses"]>(() =>
        Promise.resolve(closeBoard()),
      ),
      preflightClose: vi.fn<AttendanceTransport["preflightClose"]>(() =>
        Promise.reject(new AttendanceTransportError("preflight failed", 409)),
      ),
    });
    const view = renderScreen(failing);
    const cards = await screen.findAllByRole("region", {
      name: text.closePanel.title,
    });
    const latest = cards.at(-1);
    if (!latest) throw new Error("missing close panel");
    await userEvent.click(
      await within(latest).findByRole("button", {
        name: `코스 ${text.closePanel.confirmCta}`,
      }),
    );
    expect(await screen.findByText("preflight failed")).toBeVisible();
    view.unmount();
  });

  it("keeps a close preflight dialog open while confirmation is pending", async () => {
    const pendingConfirm =
      deferred<Awaited<ReturnType<AttendanceTransport["confirmClose"]>>>();
    const api = transport({
      listExceptions: vi.fn<AttendanceTransport["listExceptions"]>(() =>
        Promise.resolve(
          page(
            exceptions.map((item) => ({
              ...item,
              status: "RESOLVED" as const,
            })),
          ),
        ),
      ),
      listCloses: vi.fn<AttendanceTransport["listCloses"]>(() =>
        Promise.resolve({
          month: "2026-07",
          items: [{ ...closes.items[0], open_exceptions: 0 }],
        }),
      ),
      confirmClose: vi.fn<AttendanceTransport["confirmClose"]>(
        () => pendingConfirm.promise,
      ),
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
    await userEvent.click(
      within(dialog).getByLabelText(text.closePanel.attest),
    );
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: `코스 ${text.closePanel.confirmCta}`,
      }),
    );

    await assertBusyDialogCannotClose(
      dialog,
      text.closePanel.preflightTitle,
      text.closePanel.cancel,
    );
    pendingConfirm.resolve({
      id: "close-1",
      month: "2026-07",
      branch_scope: "코스",
      checks: [],
      attested_by: "actor-1",
      attested_at: "2026-07-23T11:00:00+09:00",
      closed_at: "2026-07-23T11:00:00+09:00",
      amendments: [],
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: text.closePanel.preflightTitle }),
      ).toBeNull();
    });
  });

  it("keeps month controls disabled while close preflight is pending", async () => {
    const pendingPreflight = deferred<{
      month: string;
      branch_scope: string;
      checks: [];
      can_close: true;
    }>();
    const preflightClose = vi.fn(() => pendingPreflight.promise);
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
    });
    renderScreen(api);

    const board = await screen.findByRole("region", { name: text.board.title });
    await userEvent.click(
      within(board).getByRole("button", { name: text.board.month }),
    );
    const previousMonth = await within(board).findByRole("button", {
      name: text.board.prevMonth,
    });

    const closeCard = screen.getByRole("region", {
      name: text.closePanel.title,
    });
    await userEvent.click(
      await within(closeCard).findByRole("button", {
        name: `코스 ${text.closePanel.confirmCta}`,
      }),
    );
    await waitFor(() => {
      expect(preflightClose).toHaveBeenCalledWith(
        "2026-07",
        "코스",
        expect.any(AbortSignal),
      );
    });

    expect(previousMonth).toBeDisabled();
    await userEvent.click(previousMonth);
    expect(within(board).getByText("2026년 7월")).toBeVisible();

    pendingPreflight.resolve({
      month: "2026-07",
      branch_scope: "코스",
      checks: [],
      can_close: true,
    });

    expect(
      await screen.findByRole("dialog", {
        name: text.closePanel.preflightTitle,
      }),
    ).toBeVisible();
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
    await userEvent.click(
      within(dialog).getByLabelText(text.closePanel.attest),
    );
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: `코스 ${text.closePanel.confirmCta}`,
      }),
    );

    expect(await screen.findByText("close failed")).toBeVisible();
    expect(
      screen.getByRole("dialog", { name: text.closePanel.preflightTitle }),
    ).toBeVisible();
    expect(within(card).queryByText(text.closePanel.doneBanner)).toBeNull();
    expect(screen.getByRole("button", { name: text.retry })).toBeVisible();
    expect(confirmClose).toHaveBeenCalledWith(
      "2026-07",
      "코스",
      expect.any(AbortSignal),
    );
  });

  it("acknowledges 52-hour risk through the typed port and surfaces failures", async () => {
    const ackWeek52 = vi.fn<AttendanceTransport["ackWeek52"]>(() =>
      Promise.resolve({ ...week52.items[0], acked: true }),
    );
    const api = transport({ ackWeek52 });
    const successView = renderScreen(api);
    const card = await screen.findByRole("region", { name: text.w52.title });
    await userEvent.click(
      await within(card).findByRole("button", { name: text.w52.adjust }),
    );
    await waitFor(() => {
      expect(ackWeek52).toHaveBeenCalledWith(
        "emp-1",
        "2026-07-20",
        expect.any(AbortSignal),
      );
    });
    expect(await within(card).findByText(text.w52.requested)).toBeVisible();
    successView.unmount();

    const failing = transport({
      ackWeek52: vi.fn<AttendanceTransport["ackWeek52"]>(() =>
        Promise.reject(new AttendanceTransportError("ack failed", 409)),
      ),
    });
    const view = renderScreen(failing);
    const cards = await screen.findAllByRole("region", {
      name: text.w52.title,
    });
    const latest = cards.at(-1);
    if (!latest) throw new Error("missing 52-hour panel");
    await userEvent.click(
      await within(latest).findByRole("button", { name: text.w52.adjust }),
    );
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
    expect(await within(board).findByText("김성호")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: text.board.assignSub }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: text.w52.adjust })).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: new RegExp(text.closePanel.blockedSuffix),
      }),
    ).toBeNull();
  });

  it("raises a validated exception through the typed port, refreshes the close board, and recovers from server failure", async () => {
    const createException = vi.fn<AttendanceTransport["createException"]>(
      (input) =>
        Promise.resolve(exception({ ...input, id: "raised-exception" })),
    );
    const listCloses = vi.fn<AttendanceTransport["listCloses"]>(() =>
      Promise.resolve(closes),
    );
    const view = renderScreen(transport({ createException, listCloses }));
    const card = await screen.findByRole("region", {
      name: text.exceptions.title,
    });
    const trigger = within(card).getByRole("button", { name: "예외 등록" });
    await userEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", {
      name: "근태 예외 등록",
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "예외 등록" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "필수 항목",
    );
    await userEvent.type(within(dialog).getByLabelText("직원 ID"), "emp-new");
    fireEvent.change(within(dialog).getByLabelText("발생 일자"), {
      target: { value: TODAY },
    });
    await userEvent.type(
      within(dialog).getByLabelText("사유"),
      "현장 확인으로 등록",
    );
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: /증빙 항목/ }),
      "출입기록\n근태확인서",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "예외 등록" }),
    );
    await waitFor(() => {
      expect(createException).toHaveBeenCalledWith(
        {
          kind: "LATE",
          employee_id: "emp-new",
          work_date: TODAY,
          detail: "현장 확인으로 등록",
          evidence: [{ name: "출입기록" }, { name: "근태확인서" }],
        },
        expect.any(AbortSignal),
      );
    });
    await waitFor(() => {
      expect(card.textContent).toContain("현장 확인으로 등록");
    });
    expect(listCloses.mock.calls.length).toBeGreaterThan(1);
    view.unmount();

    const failed = renderScreen(
      transport({
        createException: vi.fn<AttendanceTransport["createException"]>(() =>
          Promise.reject(new AttendanceTransportError("raise failed", 422)),
        ),
      }),
    );
    const failedCard = (
      await screen.findAllByRole("region", { name: text.exceptions.title })
    ).at(-1);
    if (!failedCard) throw new Error("missing exception card");
    await userEvent.click(
      within(failedCard).getByRole("button", { name: "예외 등록" }),
    );
    const failedDialog = await screen.findByRole("dialog", {
      name: "근태 예외 등록",
    });
    await userEvent.type(
      within(failedDialog).getByLabelText("직원 ID"),
      "emp-new",
    );
    await userEvent.type(within(failedDialog).getByLabelText("사유"), "재시도");
    await userEvent.click(
      within(failedDialog).getByRole("button", { name: "예외 등록" }),
    );
    expect(await screen.findByText("raise failed")).toBeVisible();
    expect(
      screen.getByRole("dialog", { name: "근태 예외 등록" }),
    ).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "근태 예외 등록" }),
      ).toBeNull();
    });
    failed.unmount();
  });

  it("cancels only assigned substitutions with a nonblank reason and preserves server-error recovery", async () => {
    const cancelSubstitution = vi.fn<AttendanceTransport["cancelSubstitution"]>(
      () => Promise.resolve(substitution({ status: "CANCELLED" })),
    );
    const api = transport({
      cancelSubstitution,
      listSubstitutions: vi.fn<AttendanceTransport["listSubstitutions"]>(() =>
        Promise.resolve(page([substitution()])),
      ),
    });
    renderScreen(api);
    const board = await screen.findByRole("region", { name: text.board.title });
    await userEvent.click(
      await within(board).findByRole("button", { name: "대근 취소" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "대근 편성 취소",
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "대근 취소" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      text.exceptions.reasonRequired,
    );
    await userEvent.type(
      within(dialog).getByLabelText("취소 사유"),
      "현장 수요 해소",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "대근 취소" }),
    );
    await waitFor(() => {
      expect(cancelSubstitution).toHaveBeenCalledWith(
        "sub-1",
        "현장 수요 해소",
        expect.any(AbortSignal),
      );
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "대근 편성 취소" }),
      ).toBeNull();
    });
  });

  it("adds a close amendment with typed payload and omits action CTAs for read-only access", async () => {
    const close = {
      id: "close-1",
      month: "2026-07",
      branch_scope: "코스",
      checks: [],
      attested_by: "actor-1",
      attested_at: "2026-07-23T11:00:00+09:00",
      closed_at: "2026-07-23T11:00:00+09:00",
      amendments: [],
    };
    const addCloseAmendment = vi.fn<AttendanceTransport["addCloseAmendment"]>(
      () =>
        Promise.resolve({
          id: "amend-1",
          reason: "정정",
          actor: "actor-1",
          created_at: "2026-07-23T12:00:00+09:00",
        }),
    );
    const amendmentView = renderScreen(
      transport({
        addCloseAmendment,
        listCloses: vi.fn<AttendanceTransport["listCloses"]>(() =>
          Promise.resolve({
            month: "2026-07",
            items: [
              { ...closes.items[0], closed: true, open_exceptions: 0, close },
            ],
          }),
        ),
      }),
    );
    const closeCard = await screen.findByRole("region", {
      name: text.closePanel.title,
    });
    await userEvent.click(
      await within(closeCard).findByRole("button", { name: "소급 보정" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "마감 소급 보정",
    });
    await userEvent.type(
      within(dialog).getByLabelText("보정 사유"),
      "확인 완료",
    );
    await userEvent.type(
      within(dialog).getByLabelText("보정 내용"),
      "승인된 기록 정정",
    );
    await userEvent.type(
      within(dialog).getByLabelText("연결 참조"),
      "AT-0723-01",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() => {
      expect(addCloseAmendment).toHaveBeenCalledWith(
        "close-1",
        { reason: "확인 완료", detail: "승인된 기록 정정", ref: "AT-0723-01" },
        expect.any(AbortSignal),
      );
    });
    // Isolate the read-only tree so a permitted control from the preceding scenario cannot satisfy the query.
    amendmentView.unmount();

    const readonly: AttendanceCapabilities = {
      ...manager,
      canRaise: false,
      canSubstitute: false,
      canClose: false,
    };
    const readOnlyView = renderScreen(
      transport({
        listSubstitutions: vi.fn<AttendanceTransport["listSubstitutions"]>(() =>
          Promise.resolve(page([substitution()])),
        ),
        listCloses: vi.fn<AttendanceTransport["listCloses"]>(() =>
          Promise.resolve({
            month: "2026-07",
            items: [{ ...closes.items[0], closed: true, close }],
          }),
        ),
      }),
      readonly,
    );
    expect(
      await screen.findAllByRole("region", { name: text.exceptions.title }),
    ).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "예외 등록" })).toBeNull();
    expect(screen.queryByRole("button", { name: "대근 취소" })).toBeNull();
    expect(screen.queryByRole("button", { name: "소급 보정" })).toBeNull();
    readOnlyView.unmount();
  });

  it("uses the shared focus-trapped dialog contract for exception, substitution, and preflight", async () => {
    const exceptionView = renderScreen(transport());
    const exceptionCard = await screen.findByRole("region", {
      name: text.exceptions.title,
    });
    const exceptionTrigger = await within(exceptionCard).findByRole("button", {
      name: /김성호/,
    });
    await userEvent.click(exceptionTrigger);
    await assertDialogKeyboardContract(
      text.exceptions.detailTitle,
      exceptionTrigger,
    );
    exceptionView.unmount();

    const substitutionView = renderScreen(transport());
    const board = await screen.findByRole("region", { name: text.board.title });
    const substitutionTrigger = await within(board).findByRole("button", {
      name: text.board.assignSub,
    });
    await userEvent.click(substitutionTrigger);
    await assertDialogKeyboardContract(text.sub.title, substitutionTrigger);
    substitutionView.unmount();

    const preflightView = renderScreen(
      transport({
        listExceptions: vi.fn<AttendanceTransport["listExceptions"]>(() =>
          Promise.resolve(
            page(
              exceptions.map((item) => ({
                ...item,
                status: "RESOLVED" as const,
              })),
            ),
          ),
        ),
        listCloses: vi.fn<AttendanceTransport["listCloses"]>(() =>
          Promise.resolve({
            month: "2026-07",
            items: [{ ...closes.items[0], open_exceptions: 0 }],
          }),
        ),
      }),
    );
    const closeCard = await screen.findByRole("region", {
      name: text.closePanel.title,
    });
    const closeTrigger = await within(closeCard).findByRole("button", {
      name: `코스 ${text.closePanel.confirmCta}`,
    });
    await userEvent.click(closeTrigger);
    await assertDialogKeyboardContract(
      text.closePanel.preflightTitle,
      closeTrigger,
    );
    preflightView.unmount();
  });
});

describe("AttendanceScreen route composition", () => {
  it("does not retain manager workspace while its shell slot is inactive", () => {
    const listExceptions = vi.fn<AttendanceTransport["listExceptions"]>(() =>
      Promise.resolve(page(exceptions)),
    );
    const { container } = render(
      <AttendanceScreen
        transport={transport({ listExceptions })}
        branchId="branch-1"
        actorId="actor-1"
        capabilities={manager}
        sessionKey="session-a"
        active={false}
        now={NOW}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(listExceptions).not.toHaveBeenCalled();
  });
});
