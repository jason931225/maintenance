import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AppRouter } from "../AppRouter";
import { IntakePage } from "./IntakePage";
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

function makeAuthContext(session: AuthSession | undefined): AuthContextValue {
  const api = createConsoleApiClient(session?.access_token);
  return {
    session,
    restoring: false,
    login: async () => {},
    logout: async () => {},
    refresh: async () => {},
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    api,
    viewAs: undefined,
    enterViewAs: () => {},
    exitViewAs: () => undefined,
  };
}

function renderApp(path: string, session: AuthSession | undefined) {
  return render(
    <AuthContext.Provider value={makeAuthContext(session)}>
      <MemoryRouter initialEntries={[path]}>
        <AppRouter />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

/** Render a single page in isolation (no router redirect) to test in-page gates. */
function renderPage(session: AuthSession, ui: ReactNode) {
  return render(
    <AuthContext.Provider value={makeAuthContext(session)}>
      <MemoryRouter>{ui}</MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("MEMBER landing → /pending", () => {
  it("routes a MEMBER-only session off /dispatch to the pending page", async () => {
    renderApp("/dispatch", { access_token: "a", roles: ["MEMBER"] });

    expect(
      await screen.findByRole("heading", {
        name: "계정이 생성되었습니다",
        level: 1,
      }),
    ).toBeVisible();
    // The pending page links the one surface a MEMBER can use.
    expect(
      screen.getByRole("link", { name: "내 프로필 보기" }),
    ).toBeVisible();
  });

  it("routes an empty-roles session to the pending page", async () => {
    renderApp("/dispatch", { access_token: "a", roles: [] });

    expect(
      await screen.findByRole("heading", {
        name: "계정이 생성되었습니다",
        level: 1,
      }),
    ).toBeVisible();
  });

  it("lets a MEMBER reach their own profile", async () => {
    server.use(
      http.get("*/api/v1/users/me", () =>
        HttpResponse.json({
          id: "me",
          display_name: "새 사용자",
          phone: null,
          team: "MANAGEMENT",
          roles: ["MEMBER"],
          branch_ids: [],
          is_active: true,
          created_at: "2026-01-01T00:00:00Z",
        }),
      ),
    );

    renderApp("/settings/profile", { access_token: "a", roles: ["MEMBER"] });

    // The MEMBER-state helper explains why features are unavailable.
    expect(
      await screen.findByText(
        "권한이 부여되기 전까지 일부 기능은 사용할 수 없습니다. 관리자에게 문의하세요.",
      ),
    ).toBeVisible();
  });

  it("lets a bare MEMBER reach My Attendance but keeps /overview pending", async () => {
    server.use(
      http.get("*/api/v1/hr/attendance-records/me", () =>
        HttpResponse.json({ items: [] }),
      ),
      http.get("*/api/v1/attendance/me/exceptions", () =>
        HttpResponse.json({ items: [], total: 0, limit: 50, offset: 0 }),
      ),
      http.get("*/api/v1/attendance/me/week52", () =>
        HttpResponse.json({
          status: "available",
          projection: {
            week_start: "2026-07-20",
            current_hours: 40,
            projected_hours: 40,
            tone: "OK",
            acknowledged_at: null,
          },
        }),
      ),
    );

    const { unmount } = renderApp("/attendance", {
      access_token: "a",
      roles: ["MEMBER"],
    });

    expect(
      await screen.findByRole("heading", { name: "내 근태 기록", level: 1 }),
    ).toBeVisible();
    expect(await screen.findByRole("region", { name: "내 근태" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "통합 개요" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "근태 기록" })).toHaveAttribute(
      "href",
      "/attendance",
    );
    expect(screen.getByRole("link", { name: "내 프로필" })).toHaveAttribute(
      "href",
      "/settings/profile",
    );

    unmount();
    renderApp("/overview", { access_token: "a", roles: ["MEMBER"] });

    expect(
      await screen.findByRole("heading", {
        name: "계정이 생성되었습니다",
        level: 1,
      }),
    ).toBeVisible();
  });

  it("lets a MEMBER tenant role with GROUP_ADMIN grant reach group management", async () => {
    server.use(
      http.get("*/api/v1/group-admin/groups", () =>
        HttpResponse.json({
          groups: [
            {
              id: "90000000-0000-4000-8000-000000000001",
              slug: "group",
              name: "그룹",
              status: "ACTIVE",
              members: [],
            },
          ],
        }),
      ),
    );

    renderApp("/settings/group", {
      access_token: "a",
      roles: ["MEMBER"],
      group_roles: ["GROUP_ADMIN"],
    });

    expect(
      await screen.findByRole("heading", { name: "그룹 관리", level: 1 }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "계정이 생성되었습니다" }),
    ).not.toBeInTheDocument();
  });

  it("does NOT redirect a MEMBER with runtime feature grants to the pending page", async () => {
    server.use(
      http.get("*/api/v1/work-orders", () =>
        HttpResponse.json({ items: [], total: 0 }),
      ),
    );

    renderApp("/dispatch", {
      access_token: "a",
      roles: ["MEMBER"],
      feature_grants: ["work_order_read_all"],
    });

    expect(
      await screen.findByRole("heading", { name: "배차 보드", level: 1 }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "계정이 생성되었습니다" }),
    ).not.toBeInTheDocument();
  });

  it("re-checks a pending user's token after an admin grants a role", async () => {
    const user = userEvent.setup();
    const supportAuthHeaders: Array<string | null> = [];
    server.use(
      http.get("*/api/v1/support/tickets", ({ request }) => {
        supportAuthHeaders.push(request.headers.get("authorization"));
        return HttpResponse.json({ items: [], limit: 20, offset: 0, total: 0 });
      }),
      http.get("*/api/messenger/threads", () =>
        HttpResponse.json({ items: [], total: 0 }),
      ),
      http.get("*/api/approval-items", () =>
        HttpResponse.json({ items: [], total: 0 }),
      ),
      http.get("*/api/daily-work-plans", () =>
        HttpResponse.json({ items: [], total: 0 }),
      ),
    );

    function RefreshingApp() {
      const [session, setSession] = useState<AuthSession | undefined>({
        access_token: "member",
        roles: ["MEMBER"],
      });
      const ctx: AuthContextValue = {
        ...makeAuthContext(session),
        refresh: () => {
          setSession({
            access_token: "admin",
            roles: ["ADMIN"],
            branches: ["11111111-1111-4111-8111-111111111111"],
          });
          return Promise.resolve();
        },
      };
      return (
        <AuthContext.Provider value={ctx}>
          <MemoryRouter initialEntries={["/pending"]}>
            <AppRouter />
          </MemoryRouter>
        </AuthContext.Provider>
      );
    }

    render(<RefreshingApp />);

    expect(
      await screen.findByRole("heading", {
        name: "계정이 생성되었습니다",
        level: 1,
      }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "권한 다시 확인" }));

    expect(
      await screen.findByRole("heading", { name: "통합 개요", level: 1 }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "계정이 생성되었습니다" }),
    ).not.toBeInTheDocument();
    expect(supportAuthHeaders).toContain("Bearer admin");
  });

  it("does NOT redirect a granted role off /dispatch", async () => {
    server.use(
      http.get("*/api/v1/work-orders", () =>
        HttpResponse.json({ items: [], total: 0 }),
      ),
    );

    renderApp("/dispatch", { access_token: "a", roles: ["MECHANIC"] });

    expect(
      await screen.findByRole("heading", { name: "배차 보드", level: 1 }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "계정이 생성되었습니다" }),
    ).not.toBeInTheDocument();
  });
});

describe("MEMBER /intake gate", () => {
  it("bounces a MEMBER who navigates to /intake to /pending", async () => {
    renderApp("/intake", { access_token: "a", roles: ["MEMBER"] });

    expect(
      await screen.findByRole("heading", {
        name: "계정이 생성되었습니다",
        level: 1,
      }),
    ).toBeVisible();
  });

  it("renders a permission notice (not a fillable form) when a MEMBER reaches IntakePage", () => {
    // In-page defense-in-depth: rendered in isolation (bypassing the route
    // redirect), the page must NOT show a submittable form to a MEMBER.
    renderPage(
      { access_token: "a", roles: ["MEMBER"] },
      <IntakePage />,
    );

    expect(
      screen.getByText("권한이 없습니다 — 관리자에게 문의하세요."),
    ).toBeVisible();
    // No fillable 호기 field — the form is hidden.
    expect(screen.queryByLabelText(/호기/)).not.toBeInTheDocument();
  });

  it("renders the intake form for a receptionist", () => {
    renderPage(
      {
        access_token: "a",
        roles: ["RECEPTIONIST"],
        branches: ["11111111-1111-4111-8111-111111111111"],
      },
      <IntakePage />,
    );

    // The fillable form (호기 field) is present for a WorkOrderCreate holder.
    expect(screen.getByLabelText(/호기/)).toBeInTheDocument();
    expect(
      screen.queryByText("권한이 없습니다 — 관리자에게 문의하세요."),
    ).not.toBeInTheDocument();
  });
});

describe("Topbar identity", () => {
  it("shows the display name and a role chip, never the raw user_id", async () => {
    server.use(
      http.get("*/api/v1/work-orders", () =>
        HttpResponse.json({ items: [], total: 0 }),
      ),
    );

    const session: AuthSession = {
      access_token: "a",
      user_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      display_name: "김정비",
      roles: ["MECHANIC"],
    };
    renderApp("/dispatch", session);

    await waitFor(() => {
      expect(screen.getAllByText("김정비").length).toBeGreaterThan(0);
    });
    // The role chip renders the Korean role label.
    expect(screen.getAllByText("정비사").length).toBeGreaterThan(0);
    // The raw UUID must never appear in the chrome.
    expect(
      screen.queryByText("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
    ).not.toBeInTheDocument();
  });

  it("hides location settings from group-admin-only MEMBER sessions", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/v1/group-admin/groups", () =>
        HttpResponse.json({
          groups: [
            {
              id: "90000000-0000-4000-8000-000000000001",
              slug: "group",
              name: "그룹",
              status: "ACTIVE",
              members: [],
            },
          ],
        }),
      ),
    );

    renderApp("/settings/group", {
      access_token: "a",
      display_name: "그룹관리자",
      roles: ["MEMBER"],
      group_roles: ["GROUP_ADMIN"],
    });

    expect(
      await screen.findByRole("heading", { name: "그룹 관리", level: 1 }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "사용자 메뉴" }));

    expect(screen.getByRole("menuitem", { name: "토큰 갱신" })).toBeVisible();
    expect(
      screen.queryByRole("menuitem", { name: "GPS 위치 동의" }),
    ).not.toBeInTheDocument();
  });
});
