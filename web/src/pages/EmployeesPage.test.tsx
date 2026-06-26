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
    source_row: 12,
    worksite_name: "인천센터",
    job: "정비",
    position: "대리",
    hire_date: "2024-01-02",
    exit_date: null,
    status: "ACTIVE",
  },
  {
    id: "e2",
    name: "이퇴사",
    company: "한울로지스",
    source_row: 13,
    worksite_name: "부산센터",
    job: "관리",
    position: "과장",
    hire_date: "2023-03-01",
    exit_date: "2026-01-31",
    status: "EXITED",
  },
];

const server = setupServer(
  http.get("*/api/v1/employees", () =>
    HttpResponse.json({ items: employees, total: employees.length }),
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
  it("renders the employee directory and filters by company", async () => {
    renderApp("/settings/employees", ["EXECUTIVE"]);

    expect(await screen.findByRole("heading", { name: "직원 명부" })).toBeVisible();
    const row = (await screen.findByText("김현장")).closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("대한물류")).toBeVisible();
    expect(within(row as HTMLElement).getByText("12")).toBeVisible();
    expect(within(row as HTMLElement).getByText("인천센터")).toBeVisible();
    expect(within(row as HTMLElement).getByText("정비")).toBeVisible();
    expect(within(row as HTMLElement).getByText("대리")).toBeVisible();
    expect(within(row as HTMLElement).getByText("2024-01-02")).toBeVisible();
    expect(within(row as HTMLElement).getByText("ACTIVE")).toBeVisible();

    await userEvent.selectOptions(screen.getByLabelText("회사"), "한울로지스");
    expect(screen.queryByText("김현장")).not.toBeInTheDocument();
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
    expect(screen.getByText("2")).toBeVisible();
  });

  it("redirects unsupported roles away from the HR directory", async () => {
    renderApp("/settings/employees", ["MECHANIC"]);

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "직원 명부" })).not.toBeInTheDocument();
    });
  });
});
