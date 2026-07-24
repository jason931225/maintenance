import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AppRouter } from "../AppRouter";
import { createConsoleApiClient } from "../api/client";
import type { BranchSummary, UserSummary } from "../api/types";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { userPage } from "../test/fixtures";

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

const branches: BranchSummary[] = [
  {
    id: BRANCH_A,
    region_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "강남지점",
    deactivated_at: null,
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: BRANCH_B,
    region_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "분당지점",
    deactivated_at: null,
    created_at: "2026-01-01T00:00:00Z",
  },
];

const users: UserSummary[] = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    display_name: "강남 신규",
    phone: "010-1111-1111",
    team: "OFFICE",
    roles: ["MEMBER"],
    branch_ids: [BRANCH_A],
    is_active: true,
    has_passkey: false,
    account_status: "PENDING_SETUP",
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    display_name: "분당 신규",
    phone: "010-2222-2222",
    team: "OFFICE",
    roles: ["MEMBER"],
    branch_ids: [BRANCH_B],
    is_active: true,
    has_passkey: false,
    account_status: "PENDING_SETUP",
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
    viewAs: undefined,
    enterViewAs: () => {},
    exitViewAs: () => undefined,
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

describe("AdminSettingsPage OTP issue", () => {
  it("submits a branch that belongs to the selected user", async () => {
    const user = userEvent.setup();
    let postedBranchId: string | undefined;
    server.use(
      http.get("*/api/v1/users", () => HttpResponse.json(userPage(users))),
      http.get("*/api/v1/branches", () => HttpResponse.json(branches)),
      http.post("*/api/v1/auth/admin/otp/issue", async ({ request }) => {
        const body = (await request.json()) as { branch_id: string };
        postedBranchId = body.branch_id;
        if (body.branch_id !== BRANCH_B) {
          return HttpResponse.json(
            { error: { message: "branch_id does not belong to target user" } },
            { status: 403 },
          );
        }
        return HttpResponse.json({
          user_id: users[1].id,
          otp: "BDNG1234",
          expires_at: "2026-06-28T12:00:00Z",
        });
      }),
    );

    renderApp("/settings/security", makeAuthContext(adminSession));

    await user.click(await screen.findByLabelText("사용자"));
    await user.click(await screen.findByRole("option", { name: /분당 신규/ }));

    await waitFor(() => {
      expect(screen.getByLabelText("지점")).toHaveValue("분당지점");
    });

    await user.click(screen.getByRole("button", { name: "코드 발급" }));

    expect(await screen.findByText("BDNG1234")).toBeVisible();
    expect(postedBranchId).toBe(BRANCH_B);
  });
});
