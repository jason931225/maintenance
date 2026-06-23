import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
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
});
