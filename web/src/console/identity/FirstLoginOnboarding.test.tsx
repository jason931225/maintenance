import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../../api/client";
import { AuthContext, type AcceptableTokens, type AuthContextValue, type AuthSession, type TokenAcceptanceLease } from "../../context/auth";
import { setRefreshCallbacks } from "../../api/refresh";
import { FirstLoginOnboarding } from "./FirstLoginOnboarding";
import { REQUIRED_PRIVACY_TERMS_VERSION } from "./useFirstLoginFlow";
import type { PolicyGate } from "../policy";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});

afterEach(() => {
  server.resetHandlers();
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  setRefreshCallbacks(
    () => Promise.reject(new Error("unexpected refresh in first-login test")),
    () => {},
  );
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
    acceptTokens: overrides.acceptTokens ?? (() => true),
    beginTokenAcceptance:
      overrides.beginTokenAcceptance ??
      (() => Object.freeze({}) as TokenAcceptanceLease),
    clearPasskeySetup: overrides.clearPasskeySetup ?? (() => {}),
    api,
    viewAs: overrides.viewAs,
    enterViewAs: overrides.enterViewAs ?? (() => {}),
    exitViewAs: overrides.exitViewAs ?? (() => undefined),
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function renderFirstLogin(ctx: AuthContextValue, policyGate?: PolicyGate) {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={["/onboarding"]}>
        <FirstLoginOnboarding policyGate={policyGate} />
        <LocationProbe />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

function usePrivacyConsentHandlers(initialAccepted = false) {
  let accepted = initialAccepted;
  const acceptBodies: unknown[] = [];
  server.use(
    http.post("*/api/v1/auth/privacy-consent/status", () =>
      HttpResponse.json({
        policy_version: REQUIRED_PRIVACY_TERMS_VERSION,
        accepted,
        accepted_at: accepted ? "2026-06-25T00:00:00Z" : null,
      }),
    ),
    http.post("*/api/v1/auth/privacy-consent/accept", async ({ request }) => {
      const body = await request.json();
      acceptBodies.push(body);
      accepted = true;
      return HttpResponse.json({
        policy_version: REQUIRED_PRIVACY_TERMS_VERSION,
        accepted: true,
        accepted_at: "2026-06-25T00:00:00Z",
      });
    }),
  );
  return acceptBodies;
}

function phoneQrHandoffResponse(otp = "Abcd1234") {
  return {
    otp,
    expires_at: "2026-06-14T00:05:00Z",
    enroll_url:
      `https://console.knllogistic.com/login#otp=${otp}&desktop_approve=mnt_dla_` +
      "d".repeat(64),
    poll_token: `mnt_dlp_${"e".repeat(64)}`,
  };
}

describe("FirstLoginOnboarding", () => {
  it("renders versioned PIPA consent as the only pre-enrollment path", async () => {
    const acceptBodies = usePrivacyConsentHandlers(false);

    renderFirstLogin(
      makeAuthContext({
        session: {
          access_token: "a",
          requires_passkey_setup: true,
          user_id: "user-1",
          org_id: "org-1",
        },
      }),
    );

    expect(await screen.findByText("필수 개인정보 수집·이용 및 약관 동의")).toBeVisible();
    expect(screen.getAllByText(REQUIRED_PRIVACY_TERMS_VERSION).length).toBeGreaterThan(0);
    expect(screen.getByText("수집·이용 목적")).toBeVisible();
    expect(screen.getByText("동의 필요")).toBeVisible();
    expect(screen.queryByRole("button", { name: "이 기기에 등록" })).not.toBeInTheDocument();

    const submit = screen.getByRole("button", { name: "동의 후 계속" });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/개인정보 수집·이용 안내/));
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/서비스 이용약관과 보안·감사 로그/));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await screen.findByRole("button", { name: "이 기기에 등록" });
    expect(acceptBodies).toEqual([
      {
        policy_version: REQUIRED_PRIVACY_TERMS_VERSION,
        privacy_collection: true,
        terms_of_service: true,
      },
    ]);
  }, 20_000);

  it("enrolls a platform passkey and routes to overview", async () => {
    const clearPasskeySetup = vi.fn();
    usePrivacyConsentHandlers(true);

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
    const create = vi.fn().mockResolvedValue(new FakeCredential());
    vi.stubGlobal("navigator", {
      credentials: { create, get: vi.fn() },
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

    renderFirstLogin(
      makeAuthContext({
        session: { access_token: "a", requires_passkey_setup: true },
        clearPasskeySetup,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "이 기기에 등록" }));

    await waitFor(() => {
      expect(clearPasskeySetup).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/overview");
    });
    const arg = create.mock.calls[0][0] as {
      publicKey: PublicKeyCredentialCreationOptions;
    };
    const selection = arg.publicKey.authenticatorSelection;
    expect(selection?.authenticatorAttachment).toBe("platform");
    expect(selection?.residentKey).toBe("required");
  });

  it("supports phone QR enrollment and accepts the approved desktop token", async () => {
    const acceptTokens = vi.fn();
    const clearPasskeySetup = vi.fn();
    let handoffCalls = 0;
    usePrivacyConsentHandlers(true);
    server.use(
      http.post("*/api/v1/auth/passkey/enroll-handoff", () => {
        handoffCalls += 1;
        return HttpResponse.json(phoneQrHandoffResponse());
      }),
      http.post("*/api/v1/auth/device-login/poll", () =>
        HttpResponse.json({
          status: "approved",
          access_token: "phone-qr-desktop-access",
          refresh_token: null,
          token_type: "Bearer",
          refresh_expires_at: "2026-06-14T12:00:00Z",
          requires_passkey_setup: false,
        }),
      ),
    );

    renderFirstLogin(
      makeAuthContext({
        session: { access_token: "a", requires_passkey_setup: true },
        acceptTokens,
        clearPasskeySetup,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "QR 표시" }));

    const link = await screen.findByRole("link", {
      name: "스캔이 어려우면 이 링크를 휴대폰에서 여세요",
    });
    expect(link).toHaveAttribute("href", phoneQrHandoffResponse().enroll_url);
    await waitFor(() => {
      expect(acceptTokens).toHaveBeenCalledWith({
        access_token: "phone-qr-desktop-access",
        requires_passkey_setup: false,
      }, expect.any(Object));
    });
    expect(clearPasskeySetup).toHaveBeenCalledTimes(1);
    expect(handoffCalls).toBe(1);
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/overview");
    });
  });

  it("omits denied affordances instead of disabling them", async () => {
    usePrivacyConsentHandlers(true);
    const policyGate: PolicyGate = {
      can: (action) => action !== "identity.passkey.enroll.platform",
    };

    renderFirstLogin(
      makeAuthContext({
        session: { access_token: "a", requires_passkey_setup: true },
      }),
      policyGate,
    );

    await screen.findByRole("button", { name: "QR 표시" });
    expect(screen.queryByRole("button", { name: "이 기기에 등록" })).not.toBeInTheDocument();
  });
});

describe("useFirstLoginFlow provider-owned acceptance lease fencing", () => {
  it("acquires before handoff issuance and rejects delayed phone A after accepted B", async () => {
    const events: string[] = [];
    let sequence = 0;
    let currentLease: TokenAcceptanceLease | undefined;
    let acceptedToken = "none";
    const beginTokenAcceptance = vi.fn(() => {
      events.push(`lease-${String(sequence + 1)}`);
      currentLease = Object.freeze({ sequence: ++sequence }) as unknown as TokenAcceptanceLease;
      return currentLease;
    });
    const acceptTokens = vi.fn((
      tokens: AcceptableTokens | undefined,
      lease?: TokenAcceptanceLease,
    ) => {
      if (!lease || lease !== currentLease) return false;
      currentLease = undefined;
      acceptedToken = tokens?.access_token ?? "none";
      return true;
    });
    const clearPasskeySetup = vi.fn();
    let markPollStarted!: () => void;
    const pollStarted = new Promise<void>((resolve) => {
      markPollStarted = resolve;
    });
    let releasePoll!: () => void;
    const pollBarrier = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    usePrivacyConsentHandlers(true);
    server.use(
      http.post("*/api/v1/auth/passkey/enroll-handoff", () => {
        events.push("handoff-request");
        return HttpResponse.json(phoneQrHandoffResponse("Lease123"));
      }),
      http.post("*/api/v1/auth/device-login/poll", async () => {
        events.push("poll-start");
        markPollStarted();
        await pollBarrier;
        events.push("poll-resolve");
        return HttpResponse.json({
          status: "approved",
          access_token: "delayed-first-login-a",
          requires_passkey_setup: false,
        });
      }),
    );

    renderFirstLogin(
      makeAuthContext({
        session: { access_token: "source", requires_passkey_setup: true },
        beginTokenAcceptance,
        acceptTokens,
        clearPasskeySetup,
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "QR 표시" }));
    await pollStarted;
    expect(events.indexOf("lease-1")).toBeLessThan(events.indexOf("handoff-request"));
    expect(events.indexOf("lease-1")).toBeLessThan(events.indexOf("poll-start"));

    const leaseB = beginTokenAcceptance();
    expect(acceptTokens({ access_token: "accepted-b" }, leaseB)).toBe(true);
    releasePoll();
    await waitFor(() => {
      expect(events).toContain("poll-resolve");
      expect(acceptTokens).toHaveBeenCalledWith(
        { access_token: "delayed-first-login-a", requires_passkey_setup: false },
        expect.any(Object),
      );
    });
    expect(acceptedToken).toBe("accepted-b");
    expect(clearPasskeySetup).not.toHaveBeenCalled();
    expect(screen.getByTestId("location")).toHaveTextContent("/onboarding");
  });
});
