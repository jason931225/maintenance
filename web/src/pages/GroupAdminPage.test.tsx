import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../api/client";
import { AuthContext } from "../context/auth";
import type {
  AuthContextValue,
  AuthSession,
  ViewAsState,
} from "../context/auth";
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

function makeAuthContext(
  overrides: Partial<AuthContextValue> = {},
): AuthContextValue {
  const session = overrides.session ?? groupAdminSession;
  return {
    session,
    restoring: false,
    login: async () => {},
    logout: async () => {},
    refresh: async () => {},
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    viewAs: undefined,
    enterViewAs,
    exitViewAs: () => undefined,
    api: createConsoleApiClient(session.access_token),
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{location.pathname}</p>;
}

function renderPage(authOverrides: Partial<AuthContextValue> = {}) {
  return render(
    <AuthContext.Provider value={makeAuthContext(authOverrides)}>
      <MemoryRouter initialEntries={["/settings/group"]}>
        <Routes>
          <Route path="/settings/group" element={<GroupAdminPage />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

function installHandlers(expectedToken = groupAdminSession.access_token) {
  server.use(
    http.get("*/api/v1/group-admin/groups", ({ request }) => {
      expect(request.headers.get("Authorization")).toBe(
        `Bearer ${expectedToken}`,
      );
      return HttpResponse.json({
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
      });
    }),
    http.post("*/api/v1/group-admin/tenant-context", async ({ request }) => {
      expect(request.headers.get("Authorization")).toBe(
        `Bearer ${expectedToken}`,
      );
      expect(await request.json()).toEqual({ org_id: "org-coss" });
      return HttpResponse.json({
        access_token: "tenant-context-token",
        token_type: "Bearer",
        acting_org_id: "org-coss",
        acting_org_name: "코스",
        acting_role: "GROUP_ADMIN_DELEGATED_ADMIN",
        expires_at: "2026-06-28T12:00:00Z",
      });
    }),
  );
}

describe("GroupAdminPage", () => {
  it("shows a group-wide subsidiary overview before drilling into each tenant", async () => {
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
                {
                  id: "org-bestec",
                  slug: "bestec",
                  name: "베스텍",
                  status: "SUSPENDED",
                },
              ],
            },
          ],
        }),
      ),
    );

    renderPage();

    const overview = await screen.findByRole("region", {
      name: "그룹 전체 보기",
    });
    expect(overview).toBeVisible();
    expect(overview).toHaveTextContent("그룹");
    expect(overview).toHaveTextContent("총 법인 2개");
    expect(overview).toHaveTextContent("활성 1개");
    expect(overview).toHaveTextContent("점검 필요 1개");
    expect(overview).toHaveTextContent("코스");
    expect(overview).toHaveTextContent("베스텍");
    expect(overview).not.toHaveClass("bg-ink");
  });

  it("shows a group command center and starts audited tenant management for approvals", async () => {
    const user = userEvent.setup();
    installHandlers();

    renderPage();

    expect(
      await screen.findByRole("heading", { name: "그룹 관리", level: 1 }),
    ).toBeVisible();
    expect(screen.getByText("그룹 전체 운영 지휘")).toBeVisible();
    expect(screen.getAllByText("코스").length).toBeGreaterThan(0);

    await user.click(
      screen.getByRole("button", { name: "코스 물류·정비 운영 바로가기" }),
    );
    await user.click(screen.getByRole("button", { name: "코스 전자결제" }));

    await waitFor(() => {
      expect(enterViewAs).toHaveBeenCalledWith({
        token: "tenant-context-token",
        mode: "MANAGE",
        source: "GROUP_ADMIN",
        actingOrgId: "org-coss",
        actingOrgName: "코스",
        actingRole: "GROUP_ADMIN_DELEGATED_ADMIN",
      });
    });
    expect(await screen.findByTestId("location")).toHaveTextContent(
      "/approvals",
    );
  });

  it("groups subsidiary module launchers into compact action menus without truncating labels", async () => {
    const user = userEvent.setup();
    installHandlers();

    renderPage();

    const identityMenu = await screen.findByRole("button", {
      name: "코스 계정·권한 바로가기",
    });
    expect(identityMenu).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "코스 사용자 관리" }),
    ).not.toBeInTheDocument();

    await user.click(identityMenu);

    const usersButton = await screen.findByRole("button", {
      name: "코스 사용자 관리",
    });
    expect(usersButton).toBeVisible();
    expect(usersButton).toHaveTextContent("사용자 관리");

    const assetsMenu = screen.getByRole("button", {
      name: "코스 장비·영업 바로가기",
    });
    expect(assetsMenu).toBeVisible();

    await user.click(assetsMenu);

    expect(
      await screen.findByRole("button", {
        name: "코스 장비 설정·일괄작업",
      }),
    ).toBeVisible();
  });

  it("exposes the tenant admin module launcher for each subsidiary", async () => {
    const user = userEvent.setup();
    installHandlers();

    renderPage();

    await user.click(
      await screen.findByRole("button", { name: "코스 계정·권한 바로가기" }),
    );
    expect(
      await screen.findByRole("button", { name: "코스 사용자 관리" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "코스 보안 설정" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "코스 권한 정책" }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "코스 장비·영업 바로가기" }),
    );
    expect(
      await screen.findByRole("button", {
        name: "코스 장비 설정·일괄작업",
      }),
    ).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "코스 물류·정비 운영 바로가기" }),
    );
    expect(
      await screen.findByRole("button", { name: "코스 메일함" }),
    ).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "코스 계정·권한 바로가기" }),
    );

    await user.click(screen.getByRole("button", { name: "코스 사용자 관리" }));

    await waitFor(() => {
      expect(enterViewAs).toHaveBeenCalledWith({
        token: "tenant-context-token",
        mode: "MANAGE",
        source: "GROUP_ADMIN",
        actingOrgId: "org-coss",
        actingOrgName: "코스",
        actingRole: "GROUP_ADMIN_DELEGATED_ADMIN",
      });
    });
    expect(await screen.findByTestId("location")).toHaveTextContent(
      "/settings/users",
    );
  });

  it("uses the source group-admin token when the page is opened from a delegated org context", async () => {
    const user = userEvent.setup();
    installHandlers(groupAdminSession.access_token);
    const delegatedSession: AuthSession = {
      access_token: "active-delegated-tenant-token",
      user_id: "group-admin-user",
      roles: ["ADMIN"],
      group_roles: ["GROUP_ADMIN"],
      branches: [],
    };
    const viewAs: ViewAsState = {
      token: delegatedSession.access_token,
      mode: "MANAGE",
      source: "GROUP_ADMIN",
      actingOrgId: "org-coss",
      actingOrgName: "코스",
      actingRole: "GROUP_ADMIN_DELEGATED_ADMIN",
      platformSession: groupAdminSession,
    };

    renderPage({
      session: delegatedSession,
      viewAs,
      api: createConsoleApiClient(delegatedSession.access_token),
    });

    await user.click(
      await screen.findByRole("button", { name: "코스 계정·권한 바로가기" }),
    );
    expect(
      await screen.findByRole("button", { name: "코스 사용자 관리" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "코스 사용자 관리" }));

    await waitFor(() => {
      expect(enterViewAs).toHaveBeenCalledWith({
        token: "tenant-context-token",
        mode: "MANAGE",
        source: "GROUP_ADMIN",
        actingOrgId: "org-coss",
        actingOrgName: "코스",
        actingRole: "GROUP_ADMIN_DELEGATED_ADMIN",
      });
    });
  });
});
