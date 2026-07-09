import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../api/client";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { ko } from "../i18n/ko";
import { OnboardingPage } from "./OnboardingPage";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});

afterEach(() => {
  server.resetHandlers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
});

afterAll(() => {
  server.close();
});

function makeAuthContext(
  overrides: Partial<AuthContextValue> & { session?: AuthSession },
): AuthContextValue {
  const api = createConsoleApiClient(overrides.session?.access_token);
  return {
    session: overrides.session,
    restoring: false,
    login: overrides.login ?? (async () => {}),
    logout: overrides.logout ?? (async () => {}),
    refresh: overrides.refresh ?? (async () => {}),
    acceptTokens: overrides.acceptTokens ?? (() => {}),
    clearPasskeySetup: overrides.clearPasskeySetup ?? (() => {}),
    api,
    viewAs: overrides.viewAs,
    enterViewAs: overrides.enterViewAs ?? (() => {}),
    exitViewAs: overrides.exitViewAs ?? (() => undefined),
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="current location">{location.pathname}</output>;
}

function renderPage(path: string, ctx: AuthContextValue) {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={[path]}>
        <OnboardingPage />
        <LocationProbe />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

function usePrivacyConsentHandlers(initialAccepted = false) {
  let accepted = initialAccepted;
  server.use(
    http.post("*/api/v1/auth/privacy-consent/status", () =>
      HttpResponse.json({
        policy_version: "kr-pipa-v1-2026-06-25",
        accepted,
        accepted_at: accepted ? "2026-06-25T00:00:00Z" : null,
      }),
    ),
    http.post("*/api/v1/auth/privacy-consent/accept", () => {
      accepted = true;
      return HttpResponse.json({
        policy_version: "kr-pipa-v1-2026-06-25",
        accepted: true,
        accepted_at: "2026-06-25T00:00:00Z",
      });
    }),
  );
}

function useSuccessfulPlatformPasskeyHandlers() {
  class FakeAttestationResponse {
    attestationObject = Uint8Array.from([1]).buffer;
    clientDataJSON = Uint8Array.from([2]).buffer;
  }
  class FakeCredential {
    id = "cred";
    type = "public-key";
    rawId = Uint8Array.from([3]).buffer;
    response = new FakeAttestationResponse();
  }
  vi.stubGlobal("PublicKeyCredential", FakeCredential);
  vi.stubGlobal("AuthenticatorAttestationResponse", FakeAttestationResponse);
  vi.stubGlobal("AuthenticatorAssertionResponse", class {});
  vi.stubGlobal("navigator", {
    credentials: {
      create: vi.fn().mockResolvedValue(new FakeCredential()),
      get: vi.fn(),
    },
  });
  server.use(
    http.post("*/api/v1/auth/passkey/register/start", () =>
      HttpResponse.json({
        ceremony_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        challenge: { challenge: "AQID" },
        expires_at: "2026-06-14T00:00:00Z",
      }),
    ),
    http.post("*/api/v1/auth/passkey/register/finish", () =>
      HttpResponse.json(
        {
          passkey_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          user_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          credential_id: "cred",
        },
        { status: 201 },
      ),
    ),
  );
}

describe("OnboardingPage object-first first login", () => {
  it("keeps onboarding Korean-first with actionable controls instead of explanatory captions", async () => {
    usePrivacyConsentHandlers(false);

    renderPage(
      "/onboarding",
      makeAuthContext({
        session: {
          access_token: "a",
          requires_passkey_setup: true,
          roles: ["ADMIN"],
        },
      }),
    );

    expect(
      await screen.findByRole("heading", {
        name: ko.onboarding.privacy.title,
        level: 2,
      }),
    ).toBeVisible();
    expect(screen.queryByText(ko.onboarding.subtitle)).not.toBeInTheDocument();
    expect(screen.queryByText(ko.onboarding.privacy.intro)).not.toBeInTheDocument();
    expect(screen.getByText(ko.onboarding.privacy.purposeTitle)).toBeVisible();
    expect(screen.getByText(ko.onboarding.privacy.purpose)).toBeVisible();
    expect(screen.getByText(ko.onboarding.privacy.itemsTitle)).toBeVisible();
    expect(screen.getByText(ko.onboarding.privacy.items)).toBeVisible();
    expect(screen.getByText(ko.onboarding.privacy.retentionTitle)).toBeVisible();
    expect(screen.getByText(ko.onboarding.privacy.retention)).toBeVisible();
    expect(screen.getByText(ko.onboarding.privacy.refusalTitle)).toBeVisible();
    expect(screen.getByText(ko.onboarding.privacy.refusal)).toBeVisible();
    expect(screen.queryByText(ko.onboarding.privacy.optionalNote)).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(ko.onboarding.privacy.privacyCheckbox));
    fireEvent.click(screen.getByLabelText(ko.onboarding.privacy.termsCheckbox));
    fireEvent.click(
      screen.getByRole("button", { name: ko.onboarding.privacy.submit }),
    );

    expect(
      await screen.findByRole("button", {
        name: ko.onboarding.methods.desktop.title,
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: ko.onboarding.methods.phoneQr.title }),
    ).toBeVisible();
    expect(
      screen.queryByText(ko.onboarding.methods.desktop.description),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(ko.onboarding.methods.phoneQr.description),
    ).not.toBeInTheDocument();
  }, 15_000);

  it("routes no-grant first-login users to the pending object instead of a dead work-hub link", async () => {
    const clearPasskeySetup = vi.fn();
    usePrivacyConsentHandlers(true);
    useSuccessfulPlatformPasskeyHandlers();

    renderPage(
      "/onboarding",
      makeAuthContext({
        session: {
          access_token: "a",
          requires_passkey_setup: true,
          roles: ["MEMBER"],
        },
        clearPasskeySetup,
      }),
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: ko.onboarding.methods.desktop.title,
      }),
    );

    await waitFor(() => {
      expect(clearPasskeySetup).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText("current location")).toHaveTextContent(
        "/pending",
      );
    });
  }, 15_000);

  it("routes feature-granted first-login users to their first visible console object", async () => {
    const clearPasskeySetup = vi.fn();
    usePrivacyConsentHandlers(true);
    useSuccessfulPlatformPasskeyHandlers();

    renderPage(
      "/onboarding",
      makeAuthContext({
        session: {
          access_token: "a",
          requires_passkey_setup: true,
          roles: ["MEMBER"],
          feature_grants: ["completion_review"],
        },
        clearPasskeySetup,
      }),
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: ko.onboarding.methods.desktop.title,
      }),
    );

    await waitFor(() => {
      expect(clearPasskeySetup).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText("current location")).toHaveTextContent(
        "/approvals",
      );
    });
  }, 15_000);
});
