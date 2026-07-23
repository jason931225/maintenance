import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { AppRouter } from "../AppRouter";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { createConsoleApiClient } from "../api/client";
import type { InspectionScheduleSummary } from "../api/types";
import {
  branchId,
  equipmentLookup,
  inspectionSchedulePage,
  userPage,
} from "../test/fixtures";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const scheduleId = "77777777-7777-4777-8777-777777777777";
// The equipment picker submits the chosen option's id (the autocomplete row's
// id), so the create request carries the fixture equipment's id.
const equipmentId = equipmentLookup.id;
const mechanicId = "99999999-9999-4999-8999-999999999999";

const overdueSchedule: InspectionScheduleSummary = {
  id: scheduleId,
  branch_id: branchId,
  equipment_id: equipmentId,
  mechanic_id: mechanicId,
  mechanic_display_name: "홍정비",
  cycle: "MONTHLY",
  interval_days: 30,
  due_date: "2020-01-01",
  status: "SCHEDULED",
  completed_at: null,
  note: null,
  site_name: "본사현장",
  management_no: "290",
  model: "GTS25DE",
  created_at: "2026-06-01T00:00:00Z",
  updated_at: "2026-06-01T00:00:00Z",
};

function makeAuthContext(session: AuthSession): AuthContextValue {
  return {
    session,
    restoring: false,
    login: async () => {},
    logout: async () => {},
    refresh: async () => {},
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    viewAs: undefined,
    enterViewAs: () => {},
    exitViewAs: () => undefined,
    api: createConsoleApiClient(session.access_token),
  };
}

function app(ctx: AuthContextValue) {
  return (
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={["/inspection"]}>
        <AppRouter />
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

function renderApp(ctx: AuthContextValue) {
  return render(app(ctx));
}

function SessionSwapApp({
  initial,
  next,
}: {
  initial: AuthContextValue;
  next: AuthContextValue;
}) {
  const [context, setContext] = useState(initial);
  return (
    <AuthContext.Provider value={context}>
      <MemoryRouter initialEntries={["/inspection"]}>
        <AppRouter />
        <SessionSwitcher next={next} onSwitch={setContext} />
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

function SessionSwitcher({
  next,
  onSwitch,
}: {
  next: AuthContextValue;
  onSwitch: (context: AuthContextValue) => void;
}) {
  useEffect(() => {
    onSwitch(next);
  }, [next, onSwitch]);
  return null;
}

const adminSession: AuthSession = {
  access_token: "a",
  user_id: "admin-1",
  roles: ["ADMIN"],
  branches: [branchId],
};

describe("InspectionPage", () => {
  it("keeps newer option sources when an old-session request resolves last", async () => {
    let resolveOld: (() => void) | undefined;
    let oldRequests = 0;
    let oldResponses = 0;
    const oldResponse = new Promise<void>((resolve) => {
      resolveOld = resolve;
    });
    server.use(
      http.get("*/api/v1/inspections/schedules", () =>
        HttpResponse.json(inspectionSchedulePage([])),
      ),
      http.get("*/api/v1/branches", async ({ request }) => {
        if (request.headers.get("authorization") === "Bearer old-token") {
          oldRequests += 1;
          await oldResponse;
          oldResponses += 1;
          return HttpResponse.json([
            {
              id: branchId,
              region_id: "11111111-1111-4111-8111-111111111110",
              name: "이전 지점",
              deactivated_at: null,
              created_at: "2026-06-01T00:00:00Z",
            },
          ]);
        }
        return HttpResponse.json([
          {
            id: branchId,
            region_id: "11111111-1111-4111-8111-111111111110",
            name: "새 지점",
            deactivated_at: null,
            created_at: "2026-06-01T00:00:00Z",
          },
        ]);
      }),
      http.get("*/api/v1/users", async ({ request }) => {
        if (request.headers.get("authorization") === "Bearer old-token") {
          oldRequests += 1;
          await oldResponse;
          oldResponses += 1;
        }
        return HttpResponse.json(userPage([]));
      }),
    );

    render(
      <SessionSwapApp
        initial={makeAuthContext({
          ...adminSession,
          access_token: "old-token",
        })}
        next={makeAuthContext({ ...adminSession, access_token: "new-token" })}
      />,
    );

    expect(await screen.findByRole("option", { name: "새 지점" })).toBeVisible();
    expect(oldRequests).toBeGreaterThan(0);
    resolveOld?.();
    await waitFor(() => expect(oldResponses).toBe(1));
    await waitFor(() => {
      expect(
        screen.queryByRole("option", { name: "이전 지점" }),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps the equipment query focused after selection so it can be replaced", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/v1/inspections/schedules", () =>
        HttpResponse.json(inspectionSchedulePage([])),
      ),
      http.get("*/api/v1/branches", () => HttpResponse.json([])),
      http.get("*/api/v1/users", () => HttpResponse.json(userPage([]))),
      http.get("*/api/v1/equipment", ({ request }) => {
        const query = new URL(request.url).searchParams.get("q");
        return HttpResponse.json({
          items:
            query === "291"
              ? [{ ...equipmentLookup, id: "equipment-291", management_no: "291" }]
              : [equipmentLookup],
          limit: 8,
        });
      }),
    );

    renderApp(makeAuthContext(adminSession));
    const equipment = await screen.findByLabelText("장비 (호기 번호)");
    await user.type(equipment, "290");
    await user.click(await screen.findByRole("option", { name: /290/ }));

    expect(equipment).toHaveFocus();
    await user.keyboard("{Control>}a{/Control}291");
    expect(equipment).toHaveValue("291");
    expect(await screen.findByRole("option", { name: /291/ })).toBeVisible();
  });

  it("keeps a transient schedule failure retryable and replaces it with the real response", async () => {
    const user = userEvent.setup();
    let listAttempts = 0;
    server.use(
      http.get("*/api/v1/inspections/schedules", () => {
        listAttempts += 1;
        if (listAttempts === 1) {
          return HttpResponse.json(
            { error: { message: "temporary" } },
            { status: 503 },
          );
        }
        return HttpResponse.json(inspectionSchedulePage([overdueSchedule]));
      }),
    );

    renderApp(makeAuthContext(adminSession));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "정기 일정을 불러오지 못했습니다.",
    );
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    expect((await screen.findAllByText(/본사현장/)).length).toBeGreaterThan(0);
    expect(listAttempts).toBe(2);
  });

  it("lets only the assigned session submit a durable inspection round", async () => {
    const user = userEvent.setup();
    const completed = vi.fn();
    server.use(
      http.get("*/api/v1/inspections/schedules", () =>
        HttpResponse.json(inspectionSchedulePage([overdueSchedule])),
      ),
      http.post(
        "*/api/v1/inspections/schedules/:scheduleId/rounds",
        async ({ request }) => {
          completed(await request.json());
          return HttpResponse.json(
            {
              id: "88888888-8888-4888-8888-888888888888",
              schedule_id: scheduleId,
              branch_id: branchId,
              equipment_id: equipmentId,
              mechanic_id: mechanicId,
              completed_by: mechanicId,
              outcome: "COMPLETED",
              findings: "브레이크 작동 상태 확인",
              note: null,
              completed_at: "2026-07-23T01:00:00Z",
            },
            { status: 201 },
          );
        },
      ),
    );

    renderApp(makeAuthContext({ ...adminSession, user_id: mechanicId }));

    await user.click(
      await screen.findByRole("button", { name: /290.*점검 완료/ }),
    );
    await user.type(
      screen.getByLabelText("점검 내용"),
      "브레이크 작동 상태 확인",
    );
    await user.click(screen.getByRole("button", { name: "완료 처리" }));

    await waitFor(() => {
      expect(completed).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "COMPLETED",
          findings: "브레이크 작동 상태 확인",
          note: null,
        }),
      );
    });
    expect(
      await screen.findByText("정기 점검 라운드를 완료 처리했습니다."),
    ).toBeVisible();
  });

  it("does not offer a manager an assigned mechanic's completion operation", async () => {
    const complete = vi.fn();
    server.use(
      http.get("*/api/v1/inspections/schedules", () =>
        HttpResponse.json(inspectionSchedulePage([overdueSchedule])),
      ),
      http.post("*/api/v1/inspections/schedules/:scheduleId/rounds", () => {
        complete();
        return HttpResponse.json({ id: "round-1" }, { status: 201 });
      }),
    );

    renderApp(makeAuthContext(adminSession));

    await screen.findByText("290");
    expect(
      screen.queryByRole("button", { name: /290.*점검 완료/ }),
    ).not.toBeInTheDocument();
    expect(complete).not.toHaveBeenCalled();
  });

  it("loads every manager schedule page and retries a failed next page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      ...overdueSchedule,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      management_no: `M-${String(index)}`,
    }));
    const nextPage = {
      ...overdueSchedule,
      id: "00000000-0000-4000-8000-000000000100",
      management_no: "M-100",
    };
    let moreAttempts = 0;
    server.use(
      http.get("*/api/v1/inspections/schedules", ({ request }) => {
        const offset = new URL(request.url).searchParams.get("offset");
        if (offset === "0") {
          return HttpResponse.json(inspectionSchedulePage(firstPage, 101));
        }
        moreAttempts += 1;
        if (moreAttempts === 1) {
          return HttpResponse.json(
            { error: { message: "retry" } },
            { status: 503 },
          );
        }
        return HttpResponse.json(inspectionSchedulePage([nextPage], 101));
      }),
    );

    const user = userEvent.setup();
    renderApp(makeAuthContext(adminSession));
    await screen.findByText("M-0");

    const loadMore = screen.getByRole("button", { name: /현재 100건/ });
    await user.click(loadMore);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "정기 일정을 불러오지 못했습니다.",
    );
    await user.click(screen.getByRole("button", { name: /현재 100건/ }));
    await waitFor(() => expect(moreAttempts).toBe(2));

    expect(screen.getByText("101", { selector: ".inspection-count" })).toBeVisible();
  });

  it("keeps the newest manager completion in charge when an earlier completion rejects late", async () => {
    const secondSchedule = {
      ...overdueSchedule,
      id: "88888888-8888-4888-8888-888888888888",
      management_no: "291",
    };
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let posts = 0;
    server.use(
      http.get("*/api/v1/inspections/schedules", () =>
        HttpResponse.json(
          inspectionSchedulePage([overdueSchedule, secondSchedule]),
        ),
      ),
      http.post(
        "*/api/v1/inspections/schedules/:scheduleId/rounds",
        async () => {
          posts += 1;
          if (posts === 1) {
            await firstPending;
            return HttpResponse.error();
          }
          return HttpResponse.json({ id: "round-2" }, { status: 201 });
        },
      ),
    );

    const user = userEvent.setup();
    renderApp(makeAuthContext({ ...adminSession, user_id: mechanicId }));
    await user.click(
      await screen.findByRole("button", { name: /290.*점검 완료/ }),
    );
    await user.type(screen.getByLabelText("점검 내용"), "첫 번째 처리");
    await user.click(screen.getByRole("button", { name: "완료 처리" }));
    await waitFor(() => expect(posts).toBe(1));

    await user.click(screen.getByRole("button", { name: /291.*점검 완료/ }));
    await user.type(screen.getByLabelText("점검 내용"), "두 번째 처리");
    await user.click(screen.getByRole("button", { name: "완료 처리" }));
    expect(
      await screen.findByText("정기 점검 라운드를 완료 처리했습니다."),
    ).toBeVisible();

    releaseFirst?.();
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
  });

  it("drops a delayed manager completion after the authenticated session changes", async () => {
    let releaseCompletion: (() => void) | undefined;
    const completionPending = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    server.use(
      http.get("*/api/v1/inspections/schedules", () =>
        HttpResponse.json(inspectionSchedulePage([overdueSchedule])),
      ),
      http.post(
        "*/api/v1/inspections/schedules/:scheduleId/rounds",
        async () => {
          await completionPending;
          return HttpResponse.json({ id: "round-late" }, { status: 201 });
        },
      ),
    );

    const user = userEvent.setup();
    const view = renderApp(
      makeAuthContext({ ...adminSession, user_id: mechanicId }),
    );
    await user.click(
      await screen.findByRole("button", { name: /290.*점검 완료/ }),
    );
    await user.type(screen.getByLabelText("점검 내용"), "세션 전환 전 처리");
    await user.click(screen.getByRole("button", { name: "완료 처리" }));

    view.rerender(
      <AuthContext.Provider
        value={makeAuthContext({ ...adminSession, user_id: "new-session" })}
      >
        <MemoryRouter initialEntries={["/inspection"]}>
          <AppRouter />
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    releaseCompletion?.();
    await waitFor(() =>
      expect(
        screen.queryByText("정기 점검 라운드를 완료 처리했습니다."),
      ).not.toBeInTheDocument(),
    );
  });

  it("does not retain a schedule detail that the active status filter hides", async () => {
    const completedSchedule: InspectionScheduleSummary = {
      ...overdueSchedule,
      id: "88888888-8888-4888-8888-888888888888",
      status: "COMPLETED",
      completed_at: "2026-07-23T01:00:00Z",
      management_no: "291",
    };
    server.use(
      http.get("*/api/v1/inspections/schedules", () =>
        HttpResponse.json(
          inspectionSchedulePage([overdueSchedule, completedSchedule]),
        ),
      ),
    );

    renderApp(makeAuthContext(adminSession));
    await screen.findByText("290");
    await userEvent.setup().click(screen.getByRole("button", { name: "완료" }));

    expect(
      screen.queryByRole("complementary", { name: "정기 일정" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/291/)).toBeVisible();
  });

  it("lists overdue schedules and creates a new recurring schedule", async () => {
    const user = userEvent.setup();
    const created = vi.fn();
    server.use(
      http.get("*/api/v1/inspections/schedules", () =>
        HttpResponse.json(inspectionSchedulePage([overdueSchedule])),
      ),
      // Picker option sources for the create form.
      http.get("*/api/v1/branches", () =>
        HttpResponse.json([
          {
            id: branchId,
            region_id: "11111111-1111-4111-8111-111111111110",
            name: "창원지점",
            deactivated_at: null,
            created_at: "2026-06-01T00:00:00Z",
          },
        ]),
      ),
      http.get("*/api/v1/users", () =>
        HttpResponse.json(
          userPage([
            {
              id: mechanicId,
              display_name: "홍정비",
              phone: "010-1234-5678",
              team: "MAINTENANCE",
              roles: ["MECHANIC"],
              branch_ids: [branchId],
              is_active: true,
              has_passkey: true,
              account_status: "ACTIVE",
              created_at: "2026-06-01T00:00:00Z",
            },
          ]),
        ),
      ),
      http.get("*/api/v1/equipment", () =>
        HttpResponse.json({ items: [equipmentLookup], limit: 8 }),
      ),
      http.post("*/api/v1/inspections/schedules", async ({ request }) => {
        created(await request.json());
        return HttpResponse.json(
          { ...overdueSchedule, id: "new" },
          { status: 201 },
        );
      }),
    );

    renderApp(makeAuthContext(adminSession));

    // The overdue (past-due, SCHEDULED) row is flagged.
    expect((await screen.findAllByText("지연")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/본사현장/).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("complementary", { name: "정기 일정" }),
    ).toBeVisible();
    // The assigned mechanic renders by display name (never a raw UUID).
    expect(screen.getAllByText(/홍정비/).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("담당 정비사")).not.toBeInTheDocument();

    // Console-native picker keeps the selected human label while submitting
    // the server-owned branch id.
    await user.selectOptions(screen.getByLabelText("지점"), branchId);

    // Equipment picker: server typeahead, pick by management number / model.
    await user.type(screen.getByLabelText("장비 (호기 번호)"), "290");
    await user.click(await screen.findByRole("option", { name: /290/ }));

    await user.selectOptions(screen.getByLabelText("정비사"), mechanicId);

    await user.click(screen.getByRole("button", { name: "일정 등록" }));

    await waitFor(() => {
      expect(created).toHaveBeenCalledWith(
        expect.objectContaining({
          branch_id: branchId,
          equipment_id: equipmentId,
          mechanic_id: mechanicId,
          cycle: "MONTHLY",
          interval_days: 31,
        }),
      );
    });
    expect(
      await screen.findByText("정기 예방정비 일정을 등록했습니다."),
    ).toBeVisible();
    // An administrator can coordinate schedules but the backend requires the
    // assigned prevention mechanic to complete a round. The UI must not expose
    // an action that this session cannot durably finish.
    expect(
      screen.queryByRole("button", { name: /점검 완료/ }),
    ).not.toBeInTheDocument();
  });
});
