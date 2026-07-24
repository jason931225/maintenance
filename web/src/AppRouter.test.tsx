import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppRouter } from "./AppRouter";
import { AuthContext } from "./context/auth";
import type { AuthContextValue } from "./context/auth";
import type { ConsoleApiClient } from "./api/client";
import { createConsoleApiClient } from "./api/client";
import type * as ConsoleUrl from "./lib/consoleUrl";

// Toggle the host predicate per-test; keep consoleHref (used by the storefront)
// real so the storefront branch still renders.
const isConsoleHost = vi.fn<() => boolean>();
vi.mock("./lib/consoleUrl", async (importActual) => ({
  ...(await importActual<typeof ConsoleUrl>()),
  isConsoleHost: () => isConsoleHost(),
}));

// Unauthenticated session: a redirect into the protected /console area bounces
// to /login?next=/console, which lets us assert the redirect target precisely.
function unauthContext(): AuthContextValue {
  return {
    session: null,
    restoring: false,
    login: async () => {},
    logout: async () => {},
    refresh: async () => {},
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    viewAs: undefined,
    enterViewAs: () => {},
    exitViewAs: () => undefined,
    api: createConsoleApiClient(""),
  };
}

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <div data-testid="location">{`${pathname}${search}`}</div>;
}

function authenticatedContext(api: ConsoleApiClient): AuthContextValue {
  return {
    ...unauthContext(),
    session: { access_token: "test-token", roles: ["ADMIN"], org_id: "org-1" },
    api,
  };
}

function renderAt(
  path: string,
  options: { auth?: AuthContextValue } = {},
) {
  return render(
    <AuthContext.Provider value={options.auth ?? unauthContext()}>
      <MemoryRouter initialEntries={[path]}>
        <AppRouter />
        <LocationProbe />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

const HERO = "지게차 렌탈·정비·운영을 하나로";
const INTAKE_TITLE = "정비·장비 온라인 접수";

describe("AppRouter root landing", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("renders the storefront at / on apex/www", async () => {
    isConsoleHost.mockReturnValue(false);
    renderAt("/");
    expect((await screen.findAllByText(HERO)).length).toBeGreaterThan(0);
    expect(screen.getByTestId("location").textContent).toBe("/");
  });

  it("bounces / to the console on the console host", () => {
    isConsoleHost.mockReturnValue(true);
    renderAt("/");
    // Navigate → /console; unauthenticated → /login?next=/console.
    expect(screen.getByTestId("location").textContent).toBe(
      "/login?next=%2Fconsole",
    );
    expect(screen.queryByText(HERO)).toBeNull();
  });

  it("keeps the public intake reachable on the console host", async () => {
    // Path-preserving 301 from the legacy fsm host lands /support/new here; it
    // must render the intake, not redirect into the protected console.
    isConsoleHost.mockReturnValue(true);
    renderAt("/support/new");
    expect(
      await screen.findByRole("heading", { name: INTAKE_TITLE }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("location").textContent).toBe("/support/new");
  });
});

describe("AppRouter development-only routes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    "/console-dev/window",
    "/console-dev/module",
    "/console-dev/lifecycle",
  ])("does not register %s in production", async (path) => {
    isConsoleHost.mockReturnValue(false);
    vi.stubEnv("DEV", false);
    const auth = unauthContext();
    auth.session = {
      access_token: "test-token",
      roles: ["ADMIN"],
    };

    renderAt(path, { auth });

    expect(await screen.findByTestId("location")).toHaveTextContent("/overview");
  });
});

describe("AppRouter console rollout boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("admits an authorized user to the sole evidence-approved sales route through server rollout authority", async () => {
    isConsoleHost.mockReturnValue(false);
    const api = {
      GET: vi.fn((path: string) => Promise.resolve(path === "/api/v1/console/rollout"
        ? {
            data: {
              flag_key: "console_carbon_copy",
              org_enabled: true,
              org_rollout_enabled: true,
              user_opted_in: true,
              legacy_kill_switch_enabled: false,
              kill_switch_active: false,
              effective_new_console: true,
              effective_route: "new_console",
              effective_route_for_opted_in_user: "new_console",
              effective_route_for_opted_out_user: "legacy",
              overrides_individual_toggles: false,
            },
          }
        : path === "/api/v1/sales/listings"
          ? { data: { items: [], limit: 50, offset: 0, total: 0 } }
          : path === "/api/v1/sales/inquiries"
            ? { data: { items: [], limit: 50, offset: 0, total: 0 } }
            : { data: undefined })),
      PATCH: vi.fn(),
      POST: vi.fn(),
    } as unknown as ConsoleApiClient;

    renderAt("/console/sales", { auth: authenticatedContext(api) });

    await waitFor(() => {
      expect(document.querySelector("[data-console-root]")).not.toBeNull();
    });
    expect(await screen.findByText("장비 판매 목록")).toBeVisible();
    expect(screen.getByTestId("location")).toHaveTextContent("/console/sales");
    expect(api.GET).toHaveBeenCalledWith("/api/v1/console/rollout", expect.anything());
  });

  it("admits a MEMBER only from live sales_manage capabilities and exposes only Sales", async () => {
    isConsoleHost.mockReturnValue(false);
    const api = {
      GET: vi.fn((path: string) => Promise.resolve(path === "/api/v1/console/rollout"
        ? {
            data: {
              flag_key: "console_carbon_copy",
              org_enabled: true,
              org_rollout_enabled: true,
              user_opted_in: true,
              legacy_kill_switch_enabled: false,
              kill_switch_active: false,
              effective_new_console: true,
              effective_route: "new_console",
              effective_route_for_opted_in_user: "new_console",
              effective_route_for_opted_out_user: "legacy",
              overrides_individual_toggles: false,
            },
          }
        : path === "/api/v1/sales/listings"
          ? { data: { items: [], limit: 50, offset: 0, total: 0 } }
          : path === "/api/v1/sales/inquiries"
            ? { data: { items: [], limit: 50, offset: 0, total: 0 } }
            : { data: undefined })),
      PATCH: vi.fn(),
      POST: vi.fn(),
    } as unknown as ConsoleApiClient;
    const auth = authenticatedContext(api);
    auth.session = { access_token: "member-token", roles: ["MEMBER"], org_id: "org-1" };
    const fetch = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/me/authz")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            roles: ["MEMBER"],
            capabilities: [{ feature: "sales_manage", permission: "allow", branch_scope: { kind: "all" } }],
          }),
        });
      }
      if (url.includes("/api/v1/me/notifications")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    vi.stubGlobal("fetch", fetch);

    renderAt("/console/sales", { auth });

    await waitFor(() => {
      expect(fetch).toHaveBeenCalled();
    });
    expect(await screen.findByText("장비 판매 목록")).toBeVisible();
    expect(screen.getByRole("button", { name: "판매·고객 문의" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "통합 개요" })).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/console/sales");
  });

  it("fails closed for a MEMBER with no live sales capability", async () => {
    isConsoleHost.mockReturnValue(false);
    const api = {
      GET: vi.fn((path: string) => Promise.resolve(path === "/api/v1/console/rollout"
        ? {
            data: {
              flag_key: "console_carbon_copy", org_enabled: true, org_rollout_enabled: true,
              user_opted_in: true, legacy_kill_switch_enabled: false, kill_switch_active: false,
              effective_new_console: true, effective_route: "new_console",
              effective_route_for_opted_in_user: "new_console", effective_route_for_opted_out_user: "legacy",
              overrides_individual_toggles: false,
            },
          }
        : { data: undefined })),
      PATCH: vi.fn(), POST: vi.fn(),
    } as unknown as ConsoleApiClient;
    const auth = authenticatedContext(api);
    auth.session = { access_token: "member-token", roles: ["MEMBER"], org_id: "org-1" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ roles: ["MEMBER"], capabilities: [] }),
    }));

    renderAt("/console/sales", { auth });

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/overview");
    });
    expect(screen.queryByText("장비 판매 목록")).not.toBeInTheDocument();
  });

  it("renders mounted inventory only with the explicit development preview opt-in", async () => {
    isConsoleHost.mockReturnValue(false);
    vi.stubEnv("DEV", true);
    vi.stubEnv("VITE_CONSOLE_DEV_PREVIEW", "1");
    const api = {
      GET: vi.fn().mockResolvedValue({ data: undefined }),
      POST: vi.fn().mockResolvedValue({ data: undefined }),
      DELETE: vi.fn().mockResolvedValue({ data: undefined }),
    } as unknown as ConsoleApiClient;

    renderAt("/console/mywork", { auth: authenticatedContext(api) });

    await waitFor(() => {
      expect(document.querySelector("[data-console-root]")).not.toBeNull();
    });
    expect(await screen.findByTestId("location")).toHaveTextContent("/console/mywork");
  });
});
