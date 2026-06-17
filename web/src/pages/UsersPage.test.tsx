import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AppRouter } from "../AppRouter";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { createConsoleApiClient } from "../api/client";

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

const BRANCH_A = "11111111-1111-4111-8111-111111111111";
const BRANCH_B = "22222222-2222-4222-8222-222222222222";

const branches = [
  { id: BRANCH_A, region_id: "r1", name: "강남지점", created_at: "2026-01-01T00:00:00Z" },
  { id: BRANCH_B, region_id: "r1", name: "분당지점", created_at: "2026-01-01T00:00:00Z" },
];

const users = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    display_name: "제갈태수",
    phone: "010-1234-5678",
    team: "MAINTENANCE",
    roles: ["MECHANIC"],
    branch_ids: [BRANCH_A],
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
  },
];

function makeAuthContext(session: AuthSession): AuthContextValue {
  const api = createConsoleApiClient(session.access_token);
  return {
    session,
    restoring: false,
    login: async () => {},
    logout: async () => {},
    refresh: async () => {},
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    api,
  };
}

function renderApp(path: string, ctx: AuthContextValue) {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={[path]}>
        <AppRouter />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

const adminSession: AuthSession = {
  access_token: "a",
  roles: ["ADMIN"],
  branches: [BRANCH_A],
};

describe("UsersPage gating", () => {
  it("redirects a non-admin away from /settings/users", async () => {
    renderApp(
      "/settings/users",
      makeAuthContext({ access_token: "a", roles: ["MECHANIC"] }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "사용자 관리" }),
      ).not.toBeInTheDocument();
    });
  });
});

describe("UsersPage listing", () => {
  it("renders users in a table with team, role, and branch labels", async () => {
    server.use(
      http.get("*/api/v1/users", () => HttpResponse.json(users)),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
    );

    renderApp("/settings/users", makeAuthContext(adminSession));

    const row = (await screen.findByText("제갈태수")).closest("tr");
    expect(row).not.toBeNull();
    const cells = within(row as HTMLElement);
    // The MAINTENANCE team renders as "정비"; the MECHANIC role as "정비사".
    expect(cells.getByText("정비")).toBeVisible();
    expect(cells.getByText("정비사")).toBeVisible();
    expect(cells.getByText("강남지점")).toBeVisible();
  });

  it("shows the empty state when there are no users", async () => {
    server.use(
      http.get("*/api/v1/users", () => HttpResponse.json([])),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
    );

    renderApp("/settings/users", makeAuthContext(adminSession));

    expect(await screen.findByText("등록된 사용자가 없습니다.")).toBeVisible();
  });
});

describe("UsersPage create", () => {
  it("validates required fields and posts a new user", async () => {
    const user = userEvent.setup();
    const created = vi.fn();
    server.use(
      http.get("*/api/v1/users", () => HttpResponse.json([])),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
      http.post("*/api/v1/users", async ({ request }) => {
        created(await request.json());
        return HttpResponse.json(
          {
            id: "new",
            display_name: "정민규",
            phone: null,
            team: "MAINTENANCE",
            roles: ["MECHANIC"],
            branch_ids: [BRANCH_A],
            is_active: true,
            created_at: "2026-01-01T00:00:00Z",
          },
          { status: 201 },
        );
      }),
    );

    renderApp("/settings/users", makeAuthContext(adminSession));

    await screen.findByText("등록된 사용자가 없습니다.");

    // Submitting empty surfaces the name validation error.
    await user.click(screen.getByRole("button", { name: "사용자 등록" }));
    expect(await screen.findByText("이름을 입력하세요.")).toBeVisible();

    await user.type(screen.getByLabelText("이름"), "정민규");
    // Still missing a role.
    await user.click(screen.getByRole("button", { name: "사용자 등록" }));
    expect(
      await screen.findByText("역할을 하나 이상 선택하세요."),
    ).toBeVisible();

    await user.click(screen.getByLabelText("정비사"));
    await user.click(screen.getByLabelText("강남지점"));
    await user.click(screen.getByRole("button", { name: "사용자 등록" }));

    await waitFor(() => {
      expect(created).toHaveBeenCalledWith({
        display_name: "정민규",
        phone: null,
        team: "MAINTENANCE",
        roles: ["MECHANIC"],
        branch_ids: [BRANCH_A],
      });
    });
  });
});

describe("UsersPage OTP issue", () => {
  it("issues a sign-in OTP and shows the code", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/v1/users", () => HttpResponse.json(users)),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
      http.post("*/api/v1/auth/admin/otp/issue", () =>
        HttpResponse.json({
          user_id: users[0].id,
          otp: "ABCD1234",
          expires_at: "2026-06-19T00:00:00Z",
        }),
      ),
    );

    renderApp("/settings/users", makeAuthContext(adminSession));

    const row = (await screen.findByText("제갈태수")).closest("tr");
    expect(row).not.toBeNull();
    await user.click(
      within(row as HTMLElement).getByRole("button", {
        name: "일회용 코드 발급",
      }),
    );

    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "일회용 코드 발급" }),
    );

    expect(await within(dialog).findByText("ABCD1234")).toBeVisible();
  });
});
