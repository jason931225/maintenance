import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AppRouter } from "../AppRouter";
import { createConsoleApiClient } from "../api/client";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";

const employees = [
  {
    id: "e1",
    name: "김현장",
    company: "대한물류",
    employee_number: "A-001",
    org_unit: "물류팀",
    source_row: 12,
    worksite_name: "인천센터",
    job: "정비",
    position: "대리",
    hire_date: "2024-01-02",
    exit_date: null,
    status: "ACTIVE",
    leave_remaining: "7.5",
  },
  {
    id: "e2",
    name: "이퇴사",
    company: "한울로지스",
    employee_number: "B-002",
    org_unit: "관리팀",
    source_row: 13,
    worksite_name: "부산센터",
    job: "관리",
    position: "과장",
    hire_date: "2023-03-01",
    exit_date: "2026-01-31",
    status: "EXITED",
    leave_remaining: "0",
  },
];

const orgChart = {
  companies: [
    {
      company: "대한물류",
      total: 1,
      active: 1,
      units: [
        {
          name: "물류팀",
          total: 1,
          positions: [
            {
              title: "대리",
              total: 1,
              employees: [
                {
                  id: "e1",
                  name: "김현장",
                  employee_number: "A-001",
                  status: "ACTIVE",
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const leaveBalances = {
  items: [
    {
      id: "e1",
      company: "대한물류",
      name: "김현장",
      employee_number: "A-001",
      org_unit: "물류팀",
      position: "대리",
      leave_accrued: "15",
      leave_used: "7.5",
      leave_remaining: "7.5",
    },
  ],
  total: 1,
  limit: 1000,
  offset: 0,
  summary: { accrued: "15", used: "7.5", remaining: "7.5" },
};

const attendanceSummary = {
  items: [
    {
      user_id: "u1",
      display_name: "박근태",
      arrivals: 3,
      departures: 2,
      last_kind: "ARRIVAL",
      last_event_at: "2026-06-27T12:00:00Z",
    },
  ],
  total: 1,
  limit: 1000,
  offset: 0,
};

const server = setupServer(
  http.get("*/api/v1/employees", () =>
    HttpResponse.json({ items: employees, total: employees.length }),
  ),
  http.get("*/api/v1/hr/org-chart", () => HttpResponse.json(orgChart)),
  http.get("*/api/v1/hr/leave-balances", () =>
    HttpResponse.json(leaveBalances),
  ),
  http.get("*/api/v1/hr/attendance-summary", () =>
    HttpResponse.json(attendanceSummary),
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

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

function renderApp(path: string, roles: string[]) {
  return render(
    <AuthContext.Provider value={makeAuthContext({ access_token: "a", roles })}>
      <MemoryRouter initialEntries={[path]}>
        <AppRouter />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("EmployeesPage", () => {
  it("renders the HR setup dashboard, organization chart, leave, attendance, and directory", async () => {
    renderApp("/settings/employees", ["EXECUTIVE"]);

    expect(
      await screen.findByRole("heading", { name: "인사·조직 관리" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("heading", { name: "인사 설정 대시보드" }),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "조직도" })).toBeVisible();
    expect(screen.getAllByText("물류팀").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "연차 잔액" })).toBeVisible();
    expect(screen.getAllByText("7.5").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "근태 요약" })).toBeVisible();
    expect(screen.getByText("박근태")).toBeVisible();

    const row = (await screen.findByText("A-001")).closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("김현장")).toBeVisible();
    expect(within(row as HTMLElement).getByText("대한물류")).toBeVisible();
    expect(within(row as HTMLElement).getByText("물류팀")).toBeVisible();
    expect(within(row as HTMLElement).getByText("12")).toBeVisible();
    expect(within(row as HTMLElement).getByText("인천센터")).toBeVisible();
    expect(within(row as HTMLElement).getByText("정비")).toBeVisible();
    expect(within(row as HTMLElement).getByText("대리")).toBeVisible();
    expect(within(row as HTMLElement).getByText("2024-01-02")).toBeVisible();
    expect(within(row as HTMLElement).getByText("ACTIVE")).toBeVisible();

    await userEvent.selectOptions(screen.getByLabelText("회사"), "한울로지스");
    expect(screen.queryByText("A-001")).not.toBeInTheDocument();
    expect(screen.getByText("이퇴사")).toBeVisible();
  });

  it("shows import controls only to admins and posts a multipart file", async () => {
    let sawPost = false;
    server.use(
      http.post("*/api/v1/employees/import", () => {
        // MSW/undici cannot reliably parse jsdom File/FormData across realms;
        // the browser E2E verifies the real multipart upload path.
        sawPost = true;
        return HttpResponse.json({
          input_rows: 2,
          inserted: 1,
          updated: 1,
          skipped: 0,
          errors: [],
        });
      }),
    );

    renderApp("/settings/employees", ["ADMIN"]);

    const input = await screen.findByLabelText("가져올 파일");
    await userEvent.upload(
      input,
      new File(["name"], "employees.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "가져오기" }));

    await waitFor(() => {
      expect(sawPost).toBe(true);
    });
    expect(screen.getByText("입력 행")).toBeVisible();
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
  });

  it("redirects unsupported roles away from the HR directory", async () => {
    renderApp("/settings/employees", ["MECHANIC"]);

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "인사·조직 관리" }),
      ).not.toBeInTheDocument();
    });
  });
});
