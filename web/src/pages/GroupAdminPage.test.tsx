import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../api/client";
import { AuthContext, AuthProvider, useAuth } from "../context/auth";
import type {
  AuthContextValue,
  AuthSession,
  ViewAsState,
} from "../context/auth";
import { GroupAdminPage } from "./GroupAdminPage";

const server = setupServer();
const enterViewAs = vi.fn(() => true);

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
  enterViewAs.mockReset().mockReturnValue(true);
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
    acceptTokens: () => true,
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
      screen.getByRole("button", { name: "코스 개인/부서 업무 바로가기" }),
    );
    await user.click(screen.getByRole("button", { name: "코스 전자결재시스템" }));

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
      screen.getByRole("button", { name: "코스 커뮤니케이션 바로가기" }),
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

    expect(enterViewAs).not.toHaveBeenCalled();
    expect(await screen.findByTestId("location")).toHaveTextContent(
      "/settings/users",
    );
  });
  it("fences rapid subsidiary starts and retained completions after unmount", async () => {
    const user = userEvent.setup();
    const started: string[] = [];
    const completed: string[] = [];
    let releaseCoss!: () => void;
    let releaseBestec!: () => void;
    const cossGate = new Promise<void>((resolve) => {
      releaseCoss = resolve;
    });
    const bestecGate = new Promise<void>((resolve) => {
      releaseBestec = resolve;
    });
    server.use(
      http.get("*/api/v1/group-admin/groups", () =>
        HttpResponse.json({
          groups: [
            {
              id: "group-1",
              slug: "group",
              name: "Group",
              status: "ACTIVE",
              members: [
                { id: "org-coss", slug: "coss", name: "Coss", status: "ACTIVE" },
                {
                  id: "org-bestec",
                  slug: "bestec",
                  name: "Bestec",
                  status: "ACTIVE",
                },
              ],
            },
          ],
        }),
      ),
      http.post("*/api/v1/group-admin/tenant-context", async ({ request }) => {
        const { org_id: orgId } = (await request.json()) as { org_id: string };
        started.push(orgId);
        await (orgId === "org-coss" ? cossGate : bestecGate);
        completed.push(orgId);
        return HttpResponse.json({
          access_token: orgId + "-context-token",
          acting_org_id: orgId,
          acting_org_name: orgId,
          acting_role: "GROUP_ADMIN_DELEGATED_ADMIN",
          expires_at: "2099-01-01T00:00:00Z",
        });
      }),
    );

    const view = renderPage();
    const cossCell = (await screen.findAllByText("Coss")).find((element) =>
      element.closest("tr")?.querySelector("button"),
    );
    const cossRow = cossCell?.closest("tr");
    if (!cossRow) throw new Error("Coss action row not found");
    await user.click(within(cossRow).getAllByRole("button")[0]);
    await user.click(within(cossRow).getAllByRole("button")[1]);

    const bestecCell = screen
      .getAllByText("Bestec")
      .find((element) => element.closest("tr")?.querySelector("button"));
    const bestecRow = bestecCell?.closest("tr");
    if (!bestecRow) throw new Error("Bestec action row not found");
    await user.click(within(bestecRow).getAllByRole("button")[0]);
    await user.click(within(bestecRow).getAllByRole("button")[1]);
    await waitFor(() => {
      expect(started).toEqual(["org-coss", "org-bestec"]);
    });

    await act(async () => {
      releaseCoss();
      await cossGate;
    });
    await waitFor(() => {
      expect(completed).toContain("org-coss");
    });
    expect(enterViewAs).not.toHaveBeenCalled();

    view.unmount();
    releaseBestec();
    await waitFor(() => {
      expect(completed).toContain("org-bestec");
    });
    expect(enterViewAs).not.toHaveBeenCalled();
  });

});

function groupAdminJwt(claims: Record<string, unknown>, signature: string): string {
  return `${btoa(JSON.stringify({ alg: "ES256", typ: "JWT" }))}.${btoa(
    JSON.stringify(claims),
  )}.${signature}`;
}

function RealGroupAdminAuthorityProbe({ orgAToken }: { orgAToken: string }) {
  const auth = useAuth();
  return (
    <div>
      <output data-testid="real-group-admin-authority">
        {`${auth.session?.access_token ?? "anon"}|${auth.viewAs?.actingOrgId ?? "group-all"}`}
      </output>
      <button
        type="button"
        onClick={() => {
          auth.enterViewAs({
            token: orgAToken,
            mode: "MANAGE",
            source: "GROUP_ADMIN",
            actingOrgId: "org-bestec",
            actingOrgName: "베스텍",
            actingRole: "GROUP_ADMIN_DELEGATED_ADMIN",
          });
        }}
      >
        establish-group-admin-org-a
      </button>
    </div>
  );
}

function renderRealProviderGroupAdmin(orgAToken: string) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/settings/group"]}>
        <RealGroupAdminAuthorityProbe orgAToken={orgAToken} />
        <Routes>
          <Route path="/settings/group" element={<GroupAdminPage />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe("GroupAdminPage real-provider delegated replacement", () => {
  it("uses source bearer for start/exit and navigates only after orgB replaces orgA", async () => {
    const user = userEvent.setup();
    const sourceToken = groupAdminJwt(
      { sub: "group-admin-page", roles: ["MEMBER"], group_roles: ["GROUP_ADMIN"] },
      "source",
    );
    const orgAToken = groupAdminJwt(
      { sub: "group-admin-page", org: "org-bestec", roles: ["ADMIN"] },
      "org-a",
    );
    const orgBToken = groupAdminJwt(
      { sub: "group-admin-page", org: "org-coss", roles: ["ADMIN"] },
      "org-b",
    );
    const audit: string[] = [];
    server.use(
      http.post("*/api/v1/auth/token/refresh", () =>
        HttpResponse.json({ access_token: sourceToken }),
      ),
      http.get("*/api/v1/group-admin/groups", ({ request }) => {
        const authorization = request.headers.get("authorization");
        if (authorization !== `Bearer ${sourceToken}`) {
          return HttpResponse.json({ groups: [] });
        }
        return HttpResponse.json({
          groups: [
            {
              id: "group-1",
              slug: "group",
              name: "그룹",
              status: "ACTIVE",
              members: [
                { id: "org-coss", slug: "coss", name: "코스", status: "ACTIVE" },
              ],
            },
          ],
        });
      }),
      http.post("*/api/v1/group-admin/tenant-context", async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(`Bearer ${sourceToken}`);
        expect(await request.json()).toEqual({ org_id: "org-coss" });
        audit.push("start-b-with-source");
        return HttpResponse.json({
          access_token: orgBToken,
          acting_org_id: "org-coss",
          acting_org_name: "코스",
          acting_role: "GROUP_ADMIN_DELEGATED_ADMIN",
          expires_at: "2099-01-01T00:00:00Z",
        });
      }),
      http.post("*/api/v1/group-admin/tenant-context/exit", async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(`Bearer ${sourceToken}`);
        expect(await request.json()).toEqual({ org_id: "org-bestec" });
        audit.push("exit-a-with-source");
        return HttpResponse.json({ ok: true });
      }),
    );

    renderRealProviderGroupAdmin(orgAToken);
    await waitFor(() => {
      expect(screen.getByTestId("real-group-admin-authority")).toHaveTextContent(sourceToken);
    });
    await user.click(screen.getByRole("button", { name: "establish-group-admin-org-a" }));
    await waitFor(() => {
      expect(screen.getByTestId("real-group-admin-authority")).toHaveTextContent(`${orgAToken}|org-bestec`);
    });
    await user.click(
      await screen.findByRole("button", { name: "코스 개인/부서 업무 바로가기" }),
    );
    await user.click(screen.getByRole("button", { name: "코스 전자결재시스템" }));

    await waitFor(() => {
      expect(screen.getByTestId("real-group-admin-authority")).toHaveTextContent(`${orgBToken}|org-coss`);
      expect(screen.getByTestId("location")).toHaveTextContent("/approvals");
    });
    expect(audit).toEqual(["start-b-with-source", "exit-a-with-source"]);
  });

  it("keeps orgA effective and does not navigate when its exit audit fails", async () => {
    const user = userEvent.setup();
    const sourceToken = groupAdminJwt(
      { sub: "group-admin-page", roles: ["MEMBER"], group_roles: ["GROUP_ADMIN"] },
      "source-fail",
    );
    const orgAToken = groupAdminJwt(
      { sub: "group-admin-page", org: "org-bestec", roles: ["ADMIN"] },
      "org-a-fail",
    );
    const orgBToken = groupAdminJwt(
      { sub: "group-admin-page", org: "org-coss", roles: ["ADMIN"] },
      "org-b-fail",
    );
    server.use(
      http.post("*/api/v1/auth/token/refresh", () =>
        HttpResponse.json({ access_token: sourceToken }),
      ),
      http.get("*/api/v1/group-admin/groups", () =>
        HttpResponse.json({
          groups: [
            {
              id: "group-1",
              slug: "group",
              name: "Group",
              status: "ACTIVE",
              members: [
                { id: "org-coss", slug: "coss", name: "Coss", status: "ACTIVE" },
              ],
            },
          ],
        }),
      ),
      http.post("*/api/v1/group-admin/tenant-context", () =>
        HttpResponse.json({
          access_token: orgBToken,
          acting_org_id: "org-coss",
          acting_org_name: "Coss",
          acting_role: "GROUP_ADMIN_DELEGATED_ADMIN",
          expires_at: "2099-01-01T00:00:00Z",
        }),
      ),
      http.post("*/api/v1/group-admin/tenant-context/exit", () =>
        HttpResponse.json({ error: "audit failed" }, { status: 500 }),
      ),
    );

    renderRealProviderGroupAdmin(orgAToken);
    await waitFor(() => {
      expect(screen.getByTestId("real-group-admin-authority")).toHaveTextContent(sourceToken);
    });
    await user.click(
      screen.getByRole("button", { name: "establish-group-admin-org-a" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("real-group-admin-authority")).toHaveTextContent(
        orgAToken + "|org-bestec",
      );
    });
    const cossCell = (await screen.findAllByText("Coss")).find((element) =>
      element.closest("tr")?.querySelector("button"),
    );
    const cossRow = cossCell?.closest("tr");
    if (!cossRow) throw new Error("Coss action row not found");
    await user.click(within(cossRow).getAllByRole("button")[0]);
    await user.click(within(cossRow).getAllByRole("button")[1]);

    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.getByTestId("real-group-admin-authority")).toHaveTextContent(
      orgAToken + "|org-bestec",
    );
    expect(screen.getByRole("heading", { level: 1 })).toBeVisible();
  });

});
