import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { createConsoleApiClient } from "../api/client";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { ko } from "../i18n/ko";
import { LandingPage } from "./LandingPage";

function makeCtx(
  session: AuthSession | undefined,
  restoring = false,
): AuthContextValue {
  return {
    session,
    restoring,
    login: async () => {},
    logout: async () => {},
    refresh: async () => {},
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    api: createConsoleApiClient(session?.access_token),
  };
}

function renderLanding(session?: AuthSession, restoring = false) {
  return render(
    <AuthContext.Provider value={makeCtx(session, restoring)}>
      <MemoryRouter initialEntries={["/landing"]}>
        <LandingPage />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

const session: AuthSession = {
  access_token: "test-token",
  user_id: "00000000-0000-4000-8000-000000000002",
  branches: ["00000000-0000-4000-8000-000000000001"],
};

const platformSession: AuthSession = { ...session, isPlatform: true };

describe("LandingPage", () => {
  it("renders the product, feature showcase, and FAQ", () => {
    renderLanding();
    expect(
      screen.getByRole("heading", { name: ko.landing.features.title, level: 2 }),
    ).toBeVisible();
    // Every feature group heading renders.
    for (const group of ko.landing.features.groups) {
      expect(
        screen.getByRole("heading", { name: group.title }),
      ).toBeVisible();
    }
    expect(
      screen.getByRole("heading", { name: ko.landing.faq.title }),
    ).toBeVisible();
  });

  it("shows the login CTA (→/login) when logged out", () => {
    renderLanding(undefined);
    const loginLinks = screen.getAllByRole("link", {
      name: ko.landing.nav.login,
    });
    expect(loginLinks[0]).toHaveAttribute("href", "/login");
    expect(
      screen.queryByRole("link", { name: ko.landing.nav.console }),
    ).not.toBeInTheDocument();
  });

  it("shows the console CTA (→/dispatch) + logout when logged in", () => {
    renderLanding(session);
    const consoleLinks = screen.getAllByRole("link", {
      name: ko.landing.nav.console,
    });
    expect(consoleLinks[0]).toHaveAttribute("href", "/dispatch");
    expect(
      screen.getByRole("button", { name: ko.landing.nav.logout }),
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: ko.landing.nav.login }),
    ).not.toBeInTheDocument();
  });

  it("routes a platform session to /platform", () => {
    renderLanding(platformSession);
    const consoleLinks = screen.getAllByRole("link", {
      name: ko.landing.nav.console,
    });
    expect(consoleLinks[0]).toHaveAttribute("href", "/platform");
  });

  it("routes the subscription + contact CTAs to the public inquiry form", () => {
    renderLanding();
    expect(
      screen.getByRole("link", { name: ko.landing.pricing.cta }),
    ).toHaveAttribute("href", "/support/new");
    expect(
      screen.getByRole("link", { name: ko.landing.contact.inquiryCta }),
    ).toHaveAttribute("href", "/support/new");
  });

  it("renders neither auth CTA while the session is still restoring", () => {
    renderLanding(undefined, true);
    expect(
      screen.queryByRole("link", { name: ko.landing.nav.login }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: ko.landing.nav.console }),
    ).not.toBeInTheDocument();
  });
});
