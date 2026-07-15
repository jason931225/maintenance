import { render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppRouter } from "./AppRouter";
import { AuthContext } from "./context/auth";
import type { AuthContextValue } from "./context/auth";
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
  } as AuthContextValue;
}

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <div data-testid="location">{`${pathname}${search}`}</div>;
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
