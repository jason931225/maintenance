import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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
import { ViewAsBanner } from "./ViewAsBanner";

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

const platformSession: AuthSession = {
  access_token: "platform-token",
  isPlatform: true,
};

const viewAsState: ViewAsState = {
  token: "view-as-token",
  mode: "VIEW_ONLY",
  actingOrgId: "11111111-1111-4111-8111-111111111111",
  actingOrgName: "Acme Corporation",
  actingRole: "ADMIN",
  platformSession,
};

const manageState: ViewAsState = {
  ...viewAsState,
  token: "tenant-management-token",
  mode: "MANAGE",
  actingRole: "SUPER_ADMIN",
};

function makeAuthContext(
  overrides: Partial<AuthContextValue> & { session?: AuthSession },
): AuthContextValue {
  const api = createConsoleApiClient(overrides.session?.access_token);
  return {
    session: overrides.session,
    restoring: false,
    login: async () => {},
    logout: async () => {},
    refresh: async () => {},
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    api,
    viewAs: overrides.viewAs,
    enterViewAs: overrides.enterViewAs ?? (() => {}),
    exitViewAs: overrides.exitViewAs ?? (() => undefined),
  };
}

function renderBanner(ctx: AuthContextValue) {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={["/dispatch"]}>
        <Routes>
          <Route path="/dispatch" element={<ViewAsBanner />} />
          <Route
            path="/platform/tenants"
            element={<div>platform console</div>}
          />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("ViewAsBanner", () => {
  it("renders nothing when not impersonating", () => {
    const { container } = renderBanner(
      makeAuthContext({ session: undefined, viewAs: undefined }),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the persistent read-only banner with the tenant and role while impersonating", () => {
    renderBanner(
      makeAuthContext({
        session: { access_token: "view-as-token", roles: ["ADMIN"] },
        viewAs: viewAsState,
      }),
    );

    const banner = screen.getByRole("alert");
    // The label names the tenant and the (localized) role and marks it read-only.
    expect(banner).toHaveTextContent("Acme Corporation");
    expect(banner).toHaveTextContent("관리자");
    expect(banner).toHaveTextContent("읽기 전용");
    expect(screen.getByRole("button", { name: "나가기" })).toBeVisible();
  });

  it("calls EXIT, restores the platform session, and returns to the console", async () => {
    const user = userEvent.setup();
    const exited = vi.fn();
    server.use(
      http.post("*/api/platform/view-as/exit", () => {
        exited();
        return new HttpResponse(null, { status: 200 });
      }),
    );

    const exitViewAs = vi.fn(() => "platform-token");
    renderBanner(
      makeAuthContext({
        session: { access_token: "view-as-token", roles: ["ADMIN"] },
        viewAs: viewAsState,
        exitViewAs,
      }),
    );

    await user.click(screen.getByRole("button", { name: "나가기" }));

    // The local platform session is restored (exitViewAs called) AND the platform
    // EXIT endpoint is audited, then the app navigates back to the console.
    await waitFor(() => {
      expect(exitViewAs).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(exited).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText("platform console")).toBeVisible();
  });

  it("uses the tenant-context exit endpoint for writable management mode", async () => {
    const user = userEvent.setup();
    const exited = vi.fn();
    server.use(
      http.post("*/api/platform/tenant-context/exit", () => {
        exited();
        return new HttpResponse(null, { status: 200 });
      }),
    );

    const exitViewAs = vi.fn(() => "platform-token");
    renderBanner(
      makeAuthContext({
        session: {
          access_token: "tenant-management-token",
          roles: ["SUPER_ADMIN"],
        },
        viewAs: manageState,
        exitViewAs,
      }),
    );

    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent("Acme Corporation");
    expect(banner).toHaveTextContent("최고 관리자");
    expect(banner).toHaveTextContent("변경 가능");

    await user.click(screen.getByRole("button", { name: "관리 종료" }));

    await waitFor(() => {
      expect(exitViewAs).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(exited).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText("platform console")).toBeVisible();
  });
});
