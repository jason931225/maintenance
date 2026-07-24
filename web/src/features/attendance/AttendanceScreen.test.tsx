import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { attendanceStrings as text } from "./attendanceStrings";
import type {
  AttendanceException,
  MonthCloseBoard,
  Page,
  Substitution,
  Week52Board,
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
const reader: AttendanceCapabilities = {
  ...manager,
  canRaise: false,
  canResolve: false,
  canSubstitute: false,
  canClose: false,
  canAckW52: false,
};
const denied: AttendanceCapabilities = {
  canRead: false,
  canRaise: false,
  canResolve: false,
  canSubstitute: false,
  canClose: false,
  canAckW52: false,
};

function exception(
  overrides: Partial<AttendanceException>,
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
    evidence: [{ name: "출입기록_0934.log", size: "2KB" }],
    links: [{ kind: "결재", label: "AP-3108", ref: "AP-3108" }],
    created_at: "2026-07-23T09:34:10+09:00",
    ...overrides,
  };
}

function page<T>(items: T[]): Page<T> {
  return { items, total: items.length, limit: 200, offset: 0 };
}

const openExceptions = [
  exception({}),
  exception({
    id: "ex-2",
    code: "AT-0723-02",
    kind: "NO_SHOW",
    employee_id: "emp-2",
    employee_name: "최민석",
    team: "경비팀",
    detail: "06:00 상주 미출근",
  }),
  exception({
    id: "ex-3",
    code: "AT-0723-03",
    kind: "UNAPPROVED_OVERTIME",
    employee_id: "emp-3",
    employee_name: "박지훈",
    detail: "사전승인 없는 연장 2시간",
  }),
];

const records = page([
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
]);

const summary = page([
  {
    user_id: "user-9",
    display_name: "박대근",
    arrivals: 12,
    departures: 12,
    last_kind: "DEPARTURE",
    last_event_at: "2026-07-22T18:01:00+09:00",
  },
]);

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

const closesOpen: MonthCloseBoard = {
  month: "2026-07",
  items: [
    {
      branch_scope: "코스",
      closed: false,
      open_exceptions: 3,
      pending_leave: 1,
    },
  ],
};

const closesReady: MonthCloseBoard = {
  month: "2026-07",
  items: [
    {
      branch_scope: "코스",
      closed: false,
      open_exceptions: 0,
      pending_leave: 0,
    },
  ],
};

const closesDone: MonthCloseBoard = {
  month: "2026-07",
  items: [
    {
      branch_scope: "코스",
      closed: true,
      close: {
        id: "close-1",
        month: "2026-07",
        branch_scope: "코스",
        checks: [],
        attested_by: "전성진",
        attested_at: "2026-07-23T10:40:00+09:00",
        closed_at: "2026-07-23T10:40:00+09:00",
        amendments: [],
      },
      open_exceptions: 0,
      pending_leave: 0,
    },
  ],
};

function ok<T>(data: T) {
  return { data, response: new Response(null, { status: 200 }) };
}

function fail(status: number, message: string) {
  return {
    error: { error: { message } },
    response: new Response(null, { status }),
  };
}

type Routes = Partial<Record<string, () => unknown>>;

function client(getRoutes: Routes = {}, postRoutes: Routes = {}) {
  const gets: Routes = {
    "/api/v1/attendance/exceptions": () => ok(page(openExceptions)),
    "/api/v1/attendance/substitutions": () => ok(page<Substitution>([])),
    "/api/v1/attendance/closes": () => ok(closesOpen),
    "/api/v1/attendance/week52": () => ok(week52),
    "/api/v1/hr/attendance-records": () => ok(records),
    "/api/v1/hr/attendance-summary": () => ok(summary),
    ...getRoutes,
  };
  const GET = vi.fn((path: string) => {
    const handler = gets[path];
    return Promise.resolve(handler ? handler() : fail(404, path));
  });
  const POST = vi.fn((path: string) => {
    const handler = postRoutes[path];
    return Promise.resolve(handler ? handler() : fail(404, path));
  });
  return { api: { GET, POST } as unknown as ConsoleApiClient, GET, POST };
}

function renderScreen(
  api: ConsoleApiClient,
  capabilities: AttendanceCapabilities = manager,
) {
  return render(
    <AttendanceScreen
      api={api}
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
  it("denies an unauthorized user before fetching anything", () => {
    const { api, GET } = client();
    renderScreen(api, denied);
    expect(screen.getByText(text.denied)).toBeVisible();
    expect(GET).not.toHaveBeenCalled();
  });

  it("renders board, exceptions, 52h monitor, and gated close from backend data", async () => {
    const { api } = client();
    renderScreen(api);
    // Day board: clocked-in employee with a late chip; uncovered gap gets a CTA.
    const board = await screen.findByRole("region", { name: text.board.title });
    expect(await within(board).findByText("김성호")).toBeVisible();
    expect(
      within(board).getByRole("button", { name: text.board.assignSub }),
    ).toBeVisible();
    // Exceptions queue with kind chips and the gating hint.
    const exceptionsCard = screen.getByRole("region", {
      name: text.exceptions.title,
    });
    expect(
      within(exceptionsCard).getByText(text.exceptions.kind.NO_SHOW),
    ).toBeVisible();
    expect(
      within(exceptionsCard).getByText(text.exceptions.hint),
    ).toBeVisible();
    // 52h monitor row with the adjust action.
    const w52Card = screen.getByRole("region", { name: text.w52.title });
    expect(within(w52Card).getByText("49.5h")).toBeVisible();
    expect(
      within(w52Card).getByRole("button", { name: text.w52.adjust }),
    ).toBeVisible();
    // Close panel is blocked while exceptions remain open.
    const closeCard = screen.getByRole("region", {
      name: text.closePanel.title,
    });
    expect(
      within(closeCard).getByRole("button", {
        name: new RegExp(text.closePanel.blockedSuffix),
      }),
    ).toBeVisible();
  });

  it("shows a truthful empty day board when no activity exists", async () => {
    const { api } = client({
      "/api/v1/attendance/exceptions": () => ok(page<AttendanceException>([])),
      "/api/v1/hr/attendance-records": () => ok(page<never>([])),
    });
    renderScreen(api);
    expect(await screen.findByText(text.board.dayEmpty)).toBeVisible();
  });

  it("separates a 403 panel denial from an error and offers retry only for errors", async () => {
    let failing = true;
    const { api } = client({
      "/api/v1/attendance/week52": () => fail(403, "forbidden"),
      "/api/v1/attendance/exceptions": () =>
        failing ? fail(500, "server down") : ok(page(openExceptions)),
    });
    renderScreen(api);
    const w52Card = await screen.findByRole("region", { name: text.w52.title });
    await waitFor(() => {
      expect(within(w52Card).getByText(text.panelDenied)).toBeVisible();
    });
    expect(
      within(w52Card).queryByRole("button", { name: text.retry }),
    ).toBeNull();
    const exceptionsCard = screen.getByRole("region", {
      name: text.exceptions.title,
    });
    expect(
      await within(exceptionsCard).findByText("server down"),
    ).toBeVisible();
    failing = false;
    await userEvent.click(
      within(exceptionsCard).getByRole("button", { name: text.retry }),
    );
    expect(await within(exceptionsCard).findByText("최민석")).toBeVisible();
  });

  it("requires a reason to resolve and a work link for overtime", async () => {
    const resolvePost = vi.fn(() =>
      ok(
        exception({
          id: "ex-3",
          kind: "UNAPPROVED_OVERTIME",
          status: "RESOLVED",
          employee_id: "emp-3",
          employee_name: "박지훈",
          resolution: {
            action: "APPROVE_OVERTIME",
            reason: "생산 마감 대응",
            linked_work_ref: "WO-2638",
            ot_hours: 2,
            actor: "actor-1",
            resolved_at: "2026-07-23T11:00:00+09:00",
          },
        }),
      ),
    );
    const { api, POST } = client(
      {},
      { "/api/v1/attendance/exceptions/ex-3/resolve": resolvePost },
    );
    renderScreen(api);
    const exceptionsCard = await screen.findByRole("region", {
      name: text.exceptions.title,
    });
    await userEvent.click(await within(exceptionsCard).findByText("박지훈"));
    const dialog = await screen.findByRole("dialog", {
      name: text.exceptions.detailTitle,
    });
    const submit = within(dialog).getByRole("button", {
      name: text.exceptions.resolveOvertime,
    });
    await userEvent.click(submit);
    expect(
      within(dialog).getByText(text.exceptions.reasonRequired),
    ).toBeVisible();
    expect(POST).not.toHaveBeenCalled();
    await userEvent.type(
      within(dialog).getByLabelText(text.exceptions.reasonLabel),
      "생산 마감 대응",
    );
    await userEvent.click(submit);
    expect(
      within(dialog).getByText(text.exceptions.workRefRequired),
    ).toBeVisible();
    expect(POST).not.toHaveBeenCalled();
    await userEvent.type(
      within(dialog).getByLabelText(text.exceptions.workRefLabel),
      "WO-2638",
    );
    await userEvent.click(submit);
    await waitFor(() => {
      expect(resolvePost).toHaveBeenCalled();
    });
    const [, init] = POST.mock.calls[0] as [
      string,
      { body: Record<string, unknown> },
    ];
    expect(init.body).toMatchObject({
      reason: "생산 마감 대응",
      linked_work_ref: "WO-2638",
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: text.exceptions.detailTitle }),
      ).toBeNull();
    });
  });

  it("keeps an unsent resolve reason draft across a remount", async () => {
    const { api } = client();
    const view = renderScreen(api);
    const exceptionsCard = await screen.findByRole("region", {
      name: text.exceptions.title,
    });
    await userEvent.click(await within(exceptionsCard).findByText("김성호"));
    const dialog = await screen.findByRole("dialog", {
      name: text.exceptions.detailTitle,
    });
    await userEvent.type(
      within(dialog).getByLabelText(text.exceptions.reasonLabel),
      "통근버스 지연 확인",
    );
    view.unmount();
    const second = client();
    renderScreen(second.api);
    const again = await screen.findByRole("region", {
      name: text.exceptions.title,
    });
    await userEvent.click(await within(again).findByText("김성호"));
    const reopened = await screen.findByRole("dialog", {
      name: text.exceptions.detailTitle,
    });
    expect(
      within(reopened).getByLabelText(text.exceptions.reasonLabel),
    ).toHaveValue("통근버스 지연 확인");
  });

  it("routes the blocked close CTA to the first unresolved exception", async () => {
    const { api } = client();
    renderScreen(api);
    const closeCard = await screen.findByRole("region", {
      name: text.closePanel.title,
    });
    await userEvent.click(
      await within(closeCard).findByRole("button", {
        name: new RegExp(text.closePanel.blockedSuffix),
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: text.exceptions.detailTitle,
    });
    expect(within(dialog).getByText("AT-0723-01")).toBeVisible();
  });

  it("gates close behind preflight attestation and lands on the done banner", async () => {
    let closed = false;
    const { api, POST } = client(
      {
        "/api/v1/attendance/exceptions": () =>
          ok(
            page(
              openExceptions.map((item) => ({
                ...item,
                status: "RESOLVED" as const,
              })),
            ),
          ),
        "/api/v1/attendance/closes": () =>
          ok(closed ? closesDone : closesReady),
      },
      {
        "/api/v1/attendance/closes/preflight": () =>
          ok({
            month: "2026-07",
            branch_scope: "코스",
            can_close: true,
            checks: [
              { key: "근태 예외 처리", ok: true, note: "미처리 0건" },
              { key: "미결 연차 신청", ok: true, warn: true, note: "1건 대기" },
            ],
          }),
        "/api/v1/attendance/closes": () => {
          closed = true;
          return ok(closesDone.items[0].close);
        },
      },
    );
    renderScreen(api);
    const closeCard = await screen.findByRole("region", {
      name: text.closePanel.title,
    });
    await userEvent.click(
      await within(closeCard).findByRole("button", {
        name: `코스 ${text.closePanel.confirmCta}`,
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: text.closePanel.preflightTitle,
    });
    expect(within(dialog).getByText("근태 예외 처리")).toBeVisible();
    const confirm = within(dialog).getByRole("button", {
      name: `코스 ${text.closePanel.confirmCta}`,
    });
    expect(confirm).toBeDisabled();
    await userEvent.click(
      within(dialog).getByLabelText(text.closePanel.attest),
    );
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => {
      expect(
        POST.mock.calls.some((call) => call[0] === "/api/v1/attendance/closes"),
      ).toBe(true);
    });
    expect(
      await within(closeCard).findByText(text.closePanel.doneBanner),
    ).toBeVisible();
    expect(
      within(closeCard).getByRole("link", { name: text.closePanel.goPayroll }),
    ).toHaveAttribute("href", "/console/laborcost");
  });

  it("records a 52h adjustment ack and persists the requested chip", async () => {
    const { api, POST } = client(
      {},
      {
        "/api/v1/attendance/week52/acks": () =>
          ok({
            ...week52.items[0],
            acked: true,
            acked_at: "2026-07-23T11:00:00+09:00",
          }),
      },
    );
    renderScreen(api);
    const w52Card = await screen.findByRole("region", { name: text.w52.title });
    await userEvent.click(
      await within(w52Card).findByRole("button", { name: text.w52.adjust }),
    );
    expect(await within(w52Card).findByText(text.w52.requested)).toBeVisible();
    const [, init] = POST.mock.calls[0] as [
      string,
      { body: Record<string, unknown> },
    ];
    expect(init.body).toMatchObject({
      employee_id: "emp-1",
      week_start: "2026-07-20",
    });
  });

  it("assigns a substitute through the fail-closed gap modal", async () => {
    const createPost = vi.fn(() =>
      ok({
        id: "sub-9",
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
        exception_id: "ex-2",
        created_by: "actor-1",
        created_at: "2026-07-23T11:00:00+09:00",
      }),
    );
    const { api, POST } = client(
      {},
      { "/api/v1/attendance/substitutions": createPost },
    );
    renderScreen(api);
    const board = await screen.findByRole("region", { name: text.board.title });
    await userEvent.click(
      await within(board).findByRole("button", { name: text.board.assignSub }),
    );
    const dialog = await screen.findByRole("dialog", { name: text.sub.title });
    // Pool loads from the real directory read.
    expect(await within(dialog).findByText("박대근")).toBeVisible();
    // Fail-closed: assignment without the shift facts is rejected client-side.
    await userEvent.click(
      within(dialog).getByRole("button", { name: text.sub.assign }),
    );
    expect(within(dialog).getByRole("alert")).toBeVisible();
    expect(POST).not.toHaveBeenCalled();
    await userEvent.type(within(dialog).getByLabelText(text.sub.role), "경비");
    await userEvent.type(within(dialog).getByLabelText(text.sub.from), "11:30");
    await userEvent.type(within(dialog).getByLabelText(text.sub.to), "18:00");
    await userEvent.click(
      within(dialog).getByRole("button", { name: text.sub.assign }),
    );
    await waitFor(() => {
      expect(createPost).toHaveBeenCalled();
    });
    const [, init] = POST.mock.calls[0] as [
      string,
      { body: Record<string, unknown> },
    ];
    expect(init.body).toMatchObject({
      cover_date: TODAY,
      covered_employee_id: "emp-2",
      exception_id: "ex-2",
      from_minutes: 690,
      to_minutes: 1080,
      reason_kind: "NO_SHOW",
      site: "경비팀",
      worker_name: "박대근",
    });
  });

  it("supports J/K roving focus in the month sheet and drills a row into the exception queue", async () => {
    const { api } = client();
    renderScreen(api);
    const board = await screen.findByRole("region", { name: text.board.title });
    await within(board).findByText("김성호");
    await userEvent.click(
      within(board).getByRole("button", { name: text.board.month }),
    );
    const rows = await within(board).findAllByRole("button", {
      name: /김성호|박지훈|최민석/,
    });
    rows[0].focus();
    await userEvent.keyboard("j");
    expect(rows[1]).toHaveFocus();
    await userEvent.keyboard("k");
    expect(rows[0]).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    const exceptionsCard = screen.getByRole("region", {
      name: text.exceptions.title,
    });
    expect(
      await within(exceptionsCard).findByRole("button", {
        name: text.exceptions.filterClear,
      }),
    ).toBeVisible();
    await userEvent.click(
      within(exceptionsCard).getByRole("button", {
        name: text.exceptions.filterClear,
      }),
    );
    expect(within(exceptionsCard).getByText("최민석")).toBeVisible();
  });

  it("hides every mutating control from a read-only capability set", async () => {
    const { api } = client();
    renderScreen(api, reader);
    const board = await screen.findByRole("region", { name: text.board.title });
    expect(await within(board).findByText("김성호")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: text.board.assignSub }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: text.w52.adjust })).toBeNull();
    const closeCard = screen.getByRole("region", {
      name: text.closePanel.title,
    });
    expect(
      within(closeCard).queryByRole("button", {
        name: new RegExp(text.closePanel.blockedSuffix),
      }),
    ).toBeNull();
  });
});
