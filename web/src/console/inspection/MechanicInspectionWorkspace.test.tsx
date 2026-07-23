import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createConsoleApiClient } from "../../api/client";
import type { InspectionScheduleSummary } from "../../api/types";
import { AuthContext } from "../../context/auth";
import type { AuthContextValue, AuthSession } from "../../context/auth";
import {
  branchId,
  equipmentLookup,
  inspectionSchedulePage,
} from "../../test/fixtures";
import { MechanicInspectionWorkspace } from "./MechanicInspectionWorkspace";

const server = setupServer();
const scheduleId = "77777777-7777-4777-8777-777777777777";
const mechanicId = "99999999-9999-4999-8999-999999999999";

const assignedSchedule: InspectionScheduleSummary = {
  id: scheduleId,
  branch_id: branchId,
  equipment_id: equipmentLookup.id,
  mechanic_id: mechanicId,
  mechanic_display_name: "홍정비",
  cycle: "MONTHLY",
  interval_days: 30,
  due_date: "2026-07-23",
  status: "SCHEDULED",
  completed_at: null,
  note: null,
  site_name: "본사현장",
  management_no: "290",
  model: "GTS25DE",
  created_at: "2026-06-01T00:00:00Z",
  updated_at: "2026-06-01T00:00:00Z",
};

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function context(userId = mechanicId): AuthContextValue {
  const session: AuthSession = {
    access_token: userId,
    user_id: userId,
    roles: ["MECHANIC"],
    branches: [branchId],
  };
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

function workspace(auth: AuthContextValue) {
  return (
    <AuthContext.Provider value={auth}>
      <MechanicInspectionWorkspace />
    </AuthContext.Provider>
  );
}

describe("MechanicInspectionWorkspace", () => {
  it("uses the authenticated mechanic projection and submits only a real completion", async () => {
    const user = userEvent.setup();
    const complete = vi.fn();
    server.use(
      http.get("*/api/v1/inspections/my-schedules", ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.has("mechanic_id")).toBe(false);
        return HttpResponse.json(inspectionSchedulePage([assignedSchedule]));
      }),
      http.post(
        "*/api/v1/inspections/schedules/:scheduleId/rounds",
        async ({ request }) => {
          complete(await request.json());
          return HttpResponse.json({ id: "round-1" }, { status: 201 });
        },
      ),
    );

    render(workspace(context()));
    await user.click(await screen.findByRole("button", { name: "점검 완료" }));
    await user.type(
      screen.getByLabelText("점검 내용"),
      "브레이크 작동 상태 확인",
    );
    await user.click(screen.getByRole("button", { name: "완료 처리" }));

    await waitFor(() => {
      expect(complete).toHaveBeenCalledWith({
        outcome: "COMPLETED",
        findings: "브레이크 작동 상태 확인",
        note: null,
      });
    });
  });

  it("discards a delayed prior-session schedule response", async () => {
    let resolveFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let call = 0;
    server.use(
      http.get("*/api/v1/inspections/my-schedules", async () => {
        call += 1;
        if (call === 1) {
          await firstStarted;
          return HttpResponse.json(
            inspectionSchedulePage([
              { ...assignedSchedule, management_no: "OLD" },
            ]),
          );
        }
        return HttpResponse.json(
          inspectionSchedulePage([
            { ...assignedSchedule, management_no: "NEW" },
          ]),
        );
      }),
    );

    const rendered = render(workspace(context("mechanic-old")));
    await waitFor(() => expect(call).toBe(1));
    rendered.rerender(workspace(context("mechanic-new")));
    await waitFor(() => expect(call).toBe(2));
    resolveFirst?.();

    expect(await screen.findByText("NEW")).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByText("OLD")).not.toBeInTheDocument(),
    );
  });

  it("loads the next mechanic page with an honest count, retries locally, and preserves the open row", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      ...assignedSchedule,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      management_no: `M-${index}`,
    }));
    const next = {
      ...assignedSchedule,
      id: "00000000-0000-4000-8000-000000000100",
      management_no: "M-100",
    };
    let moreAttempts = 0;
    server.use(
      http.get("*/api/v1/inspections/my-schedules", ({ request }) => {
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
        return HttpResponse.json(inspectionSchedulePage([next], 101));
      }),
    );

    const user = userEvent.setup();
    render(workspace(context()));
    await screen.findByText("M-0");
    await user.click(screen.getAllByRole("button", { name: "점검 완료" })[0]);
    expect(screen.getByLabelText("점검 내용")).toBeVisible();

    const loadMore = screen.getByRole("button", { name: /현재 100건/ });
    await user.click(loadMore);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "정기 일정을 불러오지 못했습니다.",
    );
    await user.click(loadMore);

    expect(await screen.findByText("M-100")).toBeVisible();
    expect(screen.getByText("101 / 101 건")).toBeVisible();
    expect(screen.getByLabelText("점검 내용")).toBeVisible();
  });

  it("keeps a newer same-session refresh when an older response resolves late", async () => {
    let resolveFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let call = 0;
    server.use(
      http.get("*/api/v1/inspections/my-schedules", async () => {
        call += 1;
        if (call === 1) {
          await firstPending;
          return HttpResponse.json(
            inspectionSchedulePage([
              { ...assignedSchedule, management_no: "STALE" },
            ]),
          );
        }
        return HttpResponse.json(
          inspectionSchedulePage([
            { ...assignedSchedule, management_no: "FRESH" },
          ]),
        );
      }),
    );

    render(workspace(context()));
    await waitFor(() => expect(call).toBe(1));
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "일정 조회" }));
    expect(await screen.findByText("FRESH")).toBeVisible();
    resolveFirst?.();
    await waitFor(() =>
      expect(screen.queryByText("STALE")).not.toBeInTheDocument(),
    );
  });

  it("does not surface a delayed earlier rejection after a newer retry succeeds", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let resolveFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let call = 0;
    server.use(
      http.get("*/api/v1/inspections/my-schedules", async () => {
        call += 1;
        if (call === 1) {
          await firstPending;
          throw new Error("delayed failure");
        }
        return HttpResponse.json(
          inspectionSchedulePage([
            { ...assignedSchedule, management_no: "RECOVERED" },
          ]),
        );
      }),
    );

    try {
      render(workspace(context()));
      await waitFor(() => expect(call).toBe(1));
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "일정 조회" }));
      expect(await screen.findByText("RECOVERED")).toBeVisible();
      resolveFirst?.();
      await waitFor(() =>
        expect(
          screen.queryByText("정기 일정을 불러오지 못했습니다."),
        ).not.toBeInTheDocument(),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
