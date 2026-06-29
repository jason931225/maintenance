import { render, screen, waitFor } from "@testing-library/react";
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
import { AuthContext } from "../../context/auth";
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
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    viewAs: overrides.viewAs,
    enterViewAs: overrides.enterViewAs ?? (() => {}),
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
    const enterViewAs = vi.fn();
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
      "/work-hub",
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
});
