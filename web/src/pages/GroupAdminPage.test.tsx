import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../api/client";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { GroupAdminPage } from "./GroupAdminPage";

const server = setupServer();
const enterViewAs = vi.fn();

const groupAdminSession: AuthSession = {
  access_token: "group-admin-token",
  user_id: "group-admin-user",
  roles: ["MEMBER"],
  group_roles: ["GROUP_ADMIN"],
  branches: [],
};

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
  enterViewAs.mockReset();
});

afterAll(() => {
  server.close();
});

function makeAuthContext(): AuthContextValue {
  return {
    session: groupAdminSession,
    restoring: false,
    login: async () => {},
    logout: async () => {},
    refresh: async () => {},
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    viewAs: undefined,
    enterViewAs,
    exitViewAs: () => undefined,
    api: createConsoleApiClient(groupAdminSession.access_token),
  };
}

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{location.pathname}</p>;
}

function renderPage() {
  return render(
    <AuthContext.Provider value={makeAuthContext()}>
      <MemoryRouter initialEntries={["/settings/group"]}>
        <Routes>
          <Route path="/settings/group" element={<GroupAdminPage />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

function installHandlers() {
  server.use(
    http.get("*/api/v1/group-admin/groups", () =>
      HttpResponse.json({
        groups: [
          {
            id: "group-1",
            slug: "group",
            name: "그룹",
            status: "ACTIVE",
            members: [
              {
                id: "org-coss",
                slug: "coss",
                name: "코스",
                status: "ACTIVE",
              },
            ],
          },
        ],
      }),
    ),
    http.post("*/api/v1/group-admin/tenant-context", async ({ request }) => {
      expect(await request.json()).toEqual({ org_id: "org-coss" });
      return HttpResponse.json({
        access_token: "tenant-context-token",
        token_type: "Bearer",
        acting_org_id: "org-coss",
        acting_org_name: "코스",
        acting_role: "SUPER_ADMIN",
        expires_at: "2026-06-28T12:00:00Z",
      });
    }),
  );
}

describe("GroupAdminPage", () => {
  it("shows a group command center and starts audited tenant management for approvals", async () => {
    const user = userEvent.setup();
    installHandlers();

    renderPage();

    expect(await screen.findByRole("heading", { name: "그룹 관리", level: 1 })).toBeVisible();
    expect(screen.getByText("그룹 전체 운영 지휘")).toBeVisible();
    expect(screen.getByText("코스")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "코스 승인" }));

    await waitFor(() => {
      expect(enterViewAs).toHaveBeenCalledWith({
        token: "tenant-context-token",
        mode: "MANAGE",
        source: "GROUP_ADMIN",
        actingOrgId: "org-coss",
        actingOrgName: "코스",
        actingRole: "SUPER_ADMIN",
      });
    });
    expect(await screen.findByTestId("location")).toHaveTextContent("/approvals");
  });
});
