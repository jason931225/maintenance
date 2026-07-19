import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
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
import {
  createRefreshAuthority,
  createRefreshCoordinator,
  setRefreshCallbacks,
} from "../../api/refresh";
import { AuthContext, AuthProvider, useAuth } from "../../context/auth";
import type {
  AuthContextValue,
  AuthSession,
  ViewAsState,
} from "../../context/auth";
import { GroupScopeSwitcher } from "./GroupScopeSwitcher";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});

afterAll(() => {
  server.close();
});

const groupAdminSession: AuthSession = {
  access_token: "group-source-token",
  user_id: "group-admin-user",
  roles: ["MEMBER"],
  group_roles: ["GROUP_ADMIN"],
};

function groupHandlers() {
  server.use(
    http.get("*/api/v1/group-admin/groups", ({ request }) => {
      expect(request.headers.get("authorization")).toBe(
        "Bearer group-source-token",
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
              {
                id: "org-bestec",
                slug: "bestec",
                name: "베스텍",
                status: "ACTIVE",
              },
            ],
          },
        ],
      });
    }),
  );
}

function makeAuthContext(
  overrides: Partial<AuthContextValue> & { session?: AuthSession } = {},
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
    viewAs: overrides.viewAs,
    enterViewAs: overrides.enterViewAs ?? (() => true),
    exitViewAs: overrides.exitViewAs ?? (() => undefined),
    api: createConsoleApiClient(session.access_token),
  };
}

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{location.pathname}</p>;
}

function renderSwitcher(ctx: AuthContextValue, initialPath = "/settings/group") {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <GroupScopeSwitcher />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("GroupScopeSwitcher", () => {
  it("switches from group-wide scope to any subsidiary with an audited tenant context", async () => {
    const user = userEvent.setup();
    const enterViewAs = vi.fn(() => true);
    groupHandlers();
    server.use(
      http.post("*/api/v1/group-admin/tenant-context", async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer group-source-token",
        );
        expect(await request.json()).toEqual({ org_id: "org-bestec" });
        return HttpResponse.json({
          access_token: "bestec-context-token",
          token_type: "Bearer",
          acting_org_id: "org-bestec",
          acting_org_name: "베스텍",
          acting_role: "GROUP_ADMIN_DELEGATED_ADMIN",
          expires_at: "2026-06-28T12:00:00Z",
        });
      }),
    );

    renderSwitcher(makeAuthContext({ enterViewAs }));

    const scope = await screen.findByRole("combobox", {
      name: "그룹/법인 범위",
    });
    expect(scope).toHaveValue("group:all");
    expect(scope.closest("div")).not.toHaveClass("hidden");

    await user.selectOptions(scope, "org:org-bestec");

    await waitFor(() => {
      expect(enterViewAs).toHaveBeenCalledWith({
        token: "bestec-context-token",
        mode: "MANAGE",
        source: "GROUP_ADMIN",
        actingOrgId: "org-bestec",
        actingOrgName: "베스텍",
        actingRole: "GROUP_ADMIN_DELEGATED_ADMIN",
      });
    });
    expect(await screen.findByTestId("location")).toHaveTextContent(
      "/overview",
    );
  });

  it("switches back from a selected org to the group-wide console", async () => {
    const user = userEvent.setup();
    const exitViewAs = vi.fn(() => "group-source-token");
    const groupViewAs: ViewAsState = {
      token: "coss-context-token",
      mode: "MANAGE",
      source: "GROUP_ADMIN",
      actingOrgId: "org-coss",
      actingOrgName: "코스",
      actingRole: "GROUP_ADMIN_DELEGATED_ADMIN",
      platformSession: groupAdminSession,
    };
    const exitAudit = vi.fn();
    groupHandlers();
    server.use(
      http.post(
        "*/api/v1/group-admin/tenant-context/exit",
        async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer group-source-token",
          );
          expect(await request.json()).toEqual({ org_id: "org-coss" });
          exitAudit();
          return HttpResponse.json({ ok: true });
        },
      ),
    );

    renderSwitcher(
      makeAuthContext({
        session: { access_token: "coss-context-token", roles: ["ADMIN"] },
        viewAs: groupViewAs,
        exitViewAs,
      }),
      "/equipment",
    );

    const scope = await screen.findByRole("combobox", {
      name: "그룹/법인 범위",
    });
    expect(scope).toHaveValue("org:org-coss");

    await user.selectOptions(scope, "group:all");

    await waitFor(() => {
      expect(exitViewAs).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(exitAudit).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByTestId("location")).toHaveTextContent(
      "/settings/group",
    );
  });


  it("uses the provider source authority to recover a stale group-console bearer", async () => {
    const authority = createRefreshAuthority(
      createRefreshCoordinator(),
      "group-ui-source-incarnation",
    );
    const refresh = vi.fn(() => Promise.resolve({ access_token: "fresh-group-source-token" }));
    setRefreshCallbacks(authority, refresh, () => {});
    server.use(
      http.get("*/api/v1/group-admin/groups", ({ request }) => {
        if (request.headers.get("authorization") !== "Bearer fresh-group-source-token") {
          return HttpResponse.json({ error: "unauthorized" }, { status: 401 });
        }
        return HttpResponse.json({
          groups: [
            {
              id: "group-1",
              slug: "group",
              name: "그룹",
              status: "ACTIVE",
              members: [],
            },
          ],
        });
      }),
    );

    const ctx = makeAuthContext();
    Object.assign(ctx, {
      refreshAuthority: authority,
      sourceRefreshAuthority: authority,
    });
    renderSwitcher(ctx);

    expect(
      await screen.findByRole("combobox", { name: "그룹/법인 범위" }),
    ).toBeVisible();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it("fences rapid org changes and retained completions after unmount", async () => {
    const enterViewAs = vi.fn(() => true);
    const started: string[] = [];
    const completed: string[] = [];
    let releaseBestec!: () => void;
    let releaseCoss!: () => void;
    const bestecGate = new Promise<void>((resolve) => {
      releaseBestec = resolve;
    });
    const cossGate = new Promise<void>((resolve) => {
      releaseCoss = resolve;
    });
    groupHandlers();
    server.use(
      http.post("*/api/v1/group-admin/tenant-context", async ({ request }) => {
        const { org_id: orgId } = (await request.json()) as { org_id: string };
        started.push(orgId);
        await (orgId === "org-bestec" ? bestecGate : cossGate);
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

    const view = renderSwitcher(makeAuthContext({ enterViewAs }));
    const scope = await screen.findByRole("combobox");
    fireEvent.change(scope, { target: { value: "org:org-bestec" } });
    fireEvent.change(scope, { target: { value: "org:org-coss" } });
    await waitFor(() => {
      expect(started).toEqual(["org-bestec", "org-coss"]);
    });

    await act(async () => {
      releaseBestec();
      await bestecGate;
    });
    await waitFor(() => {
      expect(completed).toContain("org-bestec");
    });
    expect(enterViewAs).not.toHaveBeenCalled();

    view.unmount();
    releaseCoss();
    await waitFor(() => {
      expect(completed).toContain("org-coss");
    });
    expect(enterViewAs).not.toHaveBeenCalled();
  });

  it("treats selecting the already effective org as an authority no-op", async () => {
    const enterViewAs = vi.fn(() => true);
    const exitViewAs = vi.fn(() => "group-source-token");
    const groupViewAs: ViewAsState = {
      token: "coss-context-token",
      mode: "MANAGE",
      source: "GROUP_ADMIN",
      actingOrgId: "org-coss",
      actingOrgName: "Coss",
      actingRole: "GROUP_ADMIN_DELEGATED_ADMIN",
      platformSession: groupAdminSession,
    };
    groupHandlers();
    renderSwitcher(
      makeAuthContext({
        session: { access_token: "coss-context-token", roles: ["ADMIN"] },
        viewAs: groupViewAs,
        enterViewAs,
        exitViewAs,
      }),
      "/equipment",
    );

    const scope = await screen.findByRole("combobox");
    fireEvent.change(scope, { target: { value: "org:org-coss" } });
    await act(async () => {
      await Promise.resolve();
    });
    expect(enterViewAs).not.toHaveBeenCalled();
    expect(exitViewAs).not.toHaveBeenCalled();
    expect(screen.getByTestId("location")).toHaveTextContent("/equipment");
  });

});

function groupJwt(claims: Record<string, unknown>, signature: string): string {
  return `${btoa(JSON.stringify({ alg: "ES256", typ: "JWT" }))}.${btoa(
    JSON.stringify(claims),
  )}.${signature}`;
}

function RealGroupAuthorityProbe({ orgAToken }: { orgAToken: string }) {
  const auth = useAuth();
  return (
    <div>
      <output data-testid="real-effective-authority">
        {`${auth.session?.access_token ?? "anon"}|${auth.viewAs?.actingOrgId ?? "group-all"}`}
      </output>
      <button
        type="button"
        onClick={() => {
          auth.enterViewAs({
            token: orgAToken,
            mode: "MANAGE",
            source: "GROUP_ADMIN",
            actingOrgId: "org-coss",
            actingOrgName: "코스",
            actingRole: "GROUP_ADMIN_DELEGATED_ADMIN",
          });
        }}
      >
        establish-org-a
      </button>
    </div>
  );
}

function renderRealProviderSwitcher(orgAToken: string) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/settings/group"]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <GroupScopeSwitcher />
                <RealGroupAuthorityProbe orgAToken={orgAToken} />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe("GroupScopeSwitcher real-provider delegated replacement", () => {
  it("audits with source authority and navigates only after orgB atomically replaces orgA", async () => {
    const user = userEvent.setup();
    const sourceToken = groupJwt(
      { sub: "group-admin", roles: ["MEMBER"], group_roles: ["GROUP_ADMIN"] },
      "source",
    );
    const orgAToken = groupJwt(
      { sub: "group-admin", org: "org-coss", roles: ["ADMIN"] },
      "org-a",
    );
    const orgBToken = groupJwt(
      { sub: "group-admin", org: "org-bestec", roles: ["ADMIN"] },
      "org-b",
    );
    const audit: string[] = [];
    server.use(
      http.post("*/api/v1/auth/token/refresh", () =>
        HttpResponse.json({ access_token: sourceToken }),
      ),
      http.get("*/api/v1/group-admin/groups", ({ request }) => {
        expect(request.headers.get("authorization")).toBe(`Bearer ${sourceToken}`);
        return HttpResponse.json({
          groups: [
            {
              id: "group-1",
              slug: "group",
              name: "그룹",
              status: "ACTIVE",
              members: [
                { id: "org-coss", slug: "coss", name: "코스", status: "ACTIVE" },
                { id: "org-bestec", slug: "bestec", name: "베스텍", status: "ACTIVE" },
              ],
            },
          ],
        });
      }),
      http.post("*/api/v1/group-admin/tenant-context", async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(`Bearer ${sourceToken}`);
        expect(await request.json()).toEqual({ org_id: "org-bestec" });
        audit.push("start-b-with-source");
        return HttpResponse.json({
          access_token: orgBToken,
          acting_org_id: "org-bestec",
          acting_org_name: "베스텍",
          acting_role: "GROUP_ADMIN_DELEGATED_ADMIN",
          expires_at: "2099-01-01T00:00:00Z",
        });
      }),
      http.post("*/api/v1/group-admin/tenant-context/exit", async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(`Bearer ${sourceToken}`);
        expect(await request.json()).toEqual({ org_id: "org-coss" });
        audit.push("exit-a-with-source");
        return HttpResponse.json({ ok: true });
      }),
    );

    renderRealProviderSwitcher(orgAToken);
    await waitFor(() => {
      expect(screen.getByTestId("real-effective-authority")).toHaveTextContent(sourceToken);
    });
    await user.click(screen.getByRole("button", { name: "establish-org-a" }));
    await waitFor(() => {
      expect(screen.getByTestId("real-effective-authority")).toHaveTextContent(`${orgAToken}|org-coss`);
    });
    const scope = await screen.findByRole("combobox", { name: "그룹/법인 범위" });
    await user.selectOptions(scope, "org:org-bestec");

    await waitFor(() => {
      expect(screen.getByTestId("real-effective-authority")).toHaveTextContent(`${orgBToken}|org-bestec`);
      expect(screen.getByTestId("location")).toHaveTextContent("/overview");
    });
    expect(audit).toEqual(["start-b-with-source", "exit-a-with-source"]);
  });

  it("keeps orgA effective and does not navigate when the source-authority exit audit fails", async () => {
    const user = userEvent.setup();
    const sourceToken = groupJwt(
      { sub: "group-admin", roles: ["MEMBER"], group_roles: ["GROUP_ADMIN"] },
      "source-fail",
    );
    const orgAToken = groupJwt(
      { sub: "group-admin", org: "org-coss", roles: ["ADMIN"] },
      "org-a-fail",
    );
    const orgBToken = groupJwt(
      { sub: "group-admin", org: "org-bestec", roles: ["ADMIN"] },
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
              name: "그룹",
              status: "ACTIVE",
              members: [
                { id: "org-coss", slug: "coss", name: "코스", status: "ACTIVE" },
                { id: "org-bestec", slug: "bestec", name: "베스텍", status: "ACTIVE" },
              ],
            },
          ],
        }),
      ),
      http.post("*/api/v1/group-admin/tenant-context", () =>
        HttpResponse.json({
          access_token: orgBToken,
          acting_org_id: "org-bestec",
          acting_org_name: "베스텍",
          acting_role: "GROUP_ADMIN_DELEGATED_ADMIN",
          expires_at: "2099-01-01T00:00:00Z",
        }),
      ),
      http.post("*/api/v1/group-admin/tenant-context/exit", () =>
        HttpResponse.json({ error: "audit failed" }, { status: 500 }),
      ),
    );

    renderRealProviderSwitcher(orgAToken);
    await waitFor(() => {
      expect(screen.getByTestId("real-effective-authority")).toHaveTextContent(sourceToken);
    });
    await user.click(screen.getByRole("button", { name: "establish-org-a" }));
    const scope = await screen.findByRole("combobox", { name: "그룹/법인 범위" });
    await user.selectOptions(scope, "org:org-bestec");
    await waitFor(() => {
      expect(scope).toHaveClass("border-console-danger-bd");
    });
    expect(screen.getByTestId("real-effective-authority")).toHaveTextContent(`${orgAToken}|org-coss`);
    expect(screen.getByTestId("location")).toHaveTextContent("/settings/group");
  });
});
