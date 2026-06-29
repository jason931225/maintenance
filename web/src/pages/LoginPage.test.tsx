import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AppRouter } from "../AppRouter";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { createConsoleApiClient } from "../api/client";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  server.resetHandlers();
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
    // Injected directly (no AuthProvider): the boot silent refresh is already
    // settled unless a test overrides it.
    restoring: overrides.restoring ?? false,
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

function renderApp(path: string, ctx: AuthContextValue) {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={[path]}>
        <AppRouter />
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

describe("LoginPage sign-in", () => {
  it("shows a sign-in card with a primary passkey button and no UUID field", () => {
    renderApp("/login", makeAuthContext({}));

    expect(
      screen.getByRole("heading", { name: "로그인", level: 2 }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "패스키로 로그인" }),
    ).toBeVisible();
    // The dead raw-UUID field must be gone.
    expect(screen.queryByLabelText("사용자 ID")).not.toBeInTheDocument();
  });

  it("runs discoverable login when the passkey button is clicked", async () => {
    const user = userEvent.setup();
    const login = vi.fn().mockResolvedValue(undefined);
    renderApp("/login", makeAuthContext({ login }));

    await user.click(screen.getByRole("button", { name: "패스키로 로그인" }));

    expect(login).toHaveBeenCalledTimes(1);
  });

  it("starts a desktop QR login and accepts the desktop token after phone approval", async () => {
    const user = userEvent.setup();
    const acceptTokens = vi.fn();
    const pollToken = `mnt_dlp_${"a".repeat(64)}`;
    const approveToken = `mnt_dla_${"b".repeat(64)}`;
    let pollCalls = 0;
    server.use(
      http.post("*/api/v1/auth/device-login/start", () =>
        HttpResponse.json({
          poll_token: pollToken,
          approve_url: `https://console.knllogistic.com/login#desktop_approve=${approveToken}`,
          expires_at: "2026-06-14T00:05:00Z",
        }),
      ),
      http.post("*/api/v1/auth/device-login/poll", async ({ request }) => {
        expect(await request.json()).toEqual({ poll_token: pollToken });
        pollCalls += 1;
        if (pollCalls === 1) {
          return HttpResponse.json({ status: "pending" });
        }
        return HttpResponse.json({
          status: "approved",
          access_token: "desktop-access",
          refresh_token: null,
          token_type: "Bearer",
          refresh_expires_at: "2026-06-14T12:00:00Z",
          requires_passkey_setup: false,
        });
      }),
      http.get("*/api/v1/work-orders", () =>
        HttpResponse.json({ items: [], limit: 8, offset: 0, total: 0 }),
      ),
      http.get("*/api/daily-work-plans", () =>
        HttpResponse.json({ items: [] }),
      ),
      http.get("*/api/v1/support/tickets", () =>
        HttpResponse.json({ items: [], next_cursor: null, total: 0 }),
      ),
      http.get("*/api/v1/ops/summary", () =>
        HttpResponse.json({
          funnel: { received: 0, assigned: 0, in_progress: 0, completed: 0 },
          aging_hours: 24,
          aging_work_orders: 0,
          sla_breached: 0,
          sla_at_risk: 0,
          mechanic_load: [],
          equipment_status: {
            rented: 0,
            spare: 0,
            scrapped: 0,
            replacement: 0,
            sold: 0,
          },
          active_substitutions: 0,
          pending_approvals: 0,
          open_support_tickets: 0,
        }),
      ),
    );

    renderApp("/login", makeAuthContext({ acceptTokens }));

    await user.click(screen.getByRole("button", { name: "휴대폰으로 PC 로그인" }));

    expect(await screen.findByText("휴대폰 승인을 기다리는 중입니다.")).toBeVisible();
    await waitFor(
      () => {
        expect(acceptTokens).toHaveBeenCalledWith({
          access_token: "desktop-access",
          requires_passkey_setup: false,
        });
      },
      { timeout: 3_000 },
    );
  });

  it("approves a desktop QR login on the phone without accepting a phone session", async () => {
    const user = userEvent.setup();
    const acceptTokens = vi.fn();
    const approveToken = `mnt_dla_${"c".repeat(64)}`;
    const approved = vi.fn();

    class FakeAssertionResponse {
      authenticatorData = Uint8Array.from([1]).buffer;
      clientDataJSON = Uint8Array.from([2]).buffer;
      signature = Uint8Array.from([3]).buffer;
      userHandle = Uint8Array.from([4]).buffer;
    }
    class FakeCredential {
      id = "cred";
      type = "public-key";
      rawId = Uint8Array.from([5]).buffer;
      response = new FakeAssertionResponse();
    }
    vi.stubGlobal("PublicKeyCredential", FakeCredential);
    vi.stubGlobal("AuthenticatorAssertionResponse", FakeAssertionResponse);
    vi.stubGlobal("AuthenticatorAttestationResponse", class {});
    vi.stubGlobal("navigator", {
      credentials: {
        get: vi.fn().mockResolvedValue(new FakeCredential()),
        create: vi.fn(),
      },
    });

    server.use(
      http.post("*/api/v1/auth/passkey/login/start", () =>
        HttpResponse.json({
          ceremony_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          challenge: { challenge: "AQID", allowCredentials: [] },
          expires_at: "2026-06-14T00:00:00Z",
        }),
      ),
      http.post("*/api/v1/auth/device-login/approve", async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.approve_token).toBe(approveToken);
        expect(body.ceremony_id).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        expect(body.credential).toBeTruthy();
        approved();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderApp(`/login#desktop_approve=${approveToken}`, makeAuthContext({ acceptTokens }));

    await user.click(await screen.findByRole("button", { name: "PC 로그인 승인" }));

    await waitFor(() => {
      expect(approved).toHaveBeenCalledTimes(1);
    });
    expect(acceptTokens).not.toHaveBeenCalled();
    expect(screen.getAllByText("PC 로그인을 승인했습니다.").length).toBeGreaterThan(0);
  });

  it("reveals an OTP input and redeems the code via acceptTokens", async () => {
    const user = userEvent.setup();
    const acceptTokens = vi.fn();
    server.use(
      http.post("*/api/v1/auth/otp/redeem", () =>
        HttpResponse.json({
          access_token: "otp-access",
          refresh_token: "otp-refresh",
          token_type: "Bearer",
          refresh_expires_at: "2026-06-19T00:00:00Z",
          requires_passkey_setup: true,
        }),
      ),
    );

    renderApp("/login", makeAuthContext({ acceptTokens }));

    await user.click(
      screen.getByRole("button", { name: "처음이신가요? 일회용 코드로 로그인" }),
    );
    await user.type(screen.getByLabelText("일회용 코드"), "ABCD1234");
    await user.click(screen.getByRole("button", { name: "코드로 로그인" }));

    await waitFor(() => {
      // Cookie transport: only the access token is carried into the session; the
      // refresh token is set as an HttpOnly cookie and never reaches JS.
      expect(acceptTokens).toHaveBeenCalledWith({
        access_token: "otp-access",
        requires_passkey_setup: true,
      });
    });
  });

  it("surfaces a friendly rate-limit message on 429", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/api/v1/auth/otp/redeem", () =>
        HttpResponse.json({ error: "rate_limited" }, { status: 429 }),
      ),
    );

    renderApp("/login", makeAuthContext({}));

    await user.click(
      screen.getByRole("button", { name: "처음이신가요? 일회용 코드로 로그인" }),
    );
    await user.type(screen.getByLabelText("일회용 코드"), "ABCD1234");
    await user.click(screen.getByRole("button", { name: "코드로 로그인" }));

    expect(
      await screen.findByText("시도가 너무 많습니다. 잠시 후 다시 시도하세요."),
    ).toBeVisible();
  });

  it("redirects an already signed-in user without next to the work hub", async () => {
    server.use(
      http.get("*/api/v1/work-orders", () =>
        HttpResponse.json({ items: [], limit: 8, offset: 0, total: 0 }),
      ),
      http.get("*/api/daily-work-plans", () =>
        HttpResponse.json({ items: [] }),
      ),
      http.get("*/api/v1/support/tickets", () =>
        HttpResponse.json({ items: [], next_cursor: null, total: 0 }),
      ),
      http.get("*/api/v1/ops/summary", () =>
        HttpResponse.json({
          funnel: { received: 0, assigned: 0, in_progress: 0, completed: 0 },
          aging_hours: 24,
          aging_work_orders: 0,
          sla_breached: 0,
          sla_at_risk: 0,
          mechanic_load: [],
          equipment_status: {
            rented: 0,
            spare: 0,
            scrapped: 0,
            replacement: 0,
            sold: 0,
          },
          active_substitutions: 0,
          pending_approvals: 0,
          open_support_tickets: 0,
        }),
      ),
    );

    renderApp(
      "/login",
      makeAuthContext({
        session: {
          access_token: "a",
          roles: ["ADMIN"],
        },
      }),
    );

    expect(
      await screen.findByRole("heading", { name: "업무 허브", level: 1 }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "로그인", level: 2 }),
    ).not.toBeInTheDocument();
  });
});

describe("requires_passkey_setup routing", () => {
  it("forces an OTP-first session into /onboarding", async () => {
    usePrivacyConsentHandlers();
    const session: AuthSession = {
      access_token: "a",
      requires_passkey_setup: true,
    };
    renderApp("/dispatch", makeAuthContext({ session }));

    expect(
      await screen.findByRole("heading", { name: "패스키 등록", level: 1 }),
    ).toBeVisible();
    expect(
      await screen.findByRole("heading", {
        name: "필수 개인정보 수집·이용 및 약관 동의",
        level: 2,
      }),
    ).toBeVisible();
  });
});

describe("admin security page gating", () => {
  it("redirects a non-admin away from /settings/security", async () => {
    const session: AuthSession = {
      access_token: "a",
      roles: ["MECHANIC"],
    };
    renderApp("/settings/security", makeAuthContext({ session }));

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "관리자 설정" }),
      ).not.toBeInTheDocument();
    });
  });

  it("renders the admin OTP issue form for an admin", async () => {
    const session: AuthSession = {
      access_token: "a",
      roles: ["ADMIN"],
      branches: ["11111111-1111-4111-8111-111111111111"],
    };
    renderApp("/settings/security", makeAuthContext({ session }));

    expect(
      await screen.findByRole("heading", { name: "일회용 로그인 코드 발급", level: 2 }),
    ).toBeVisible();
  });
});

describe("OnboardingPage enrollment", () => {
  it("blocks enrollment until the two required agreements are accepted separately", async () => {
    const user = userEvent.setup();
    usePrivacyConsentHandlers(false);

    renderApp(
      "/onboarding",
      makeAuthContext({
        session: {
          access_token: "a",
          requires_passkey_setup: true,
        },
      }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "필수 개인정보 수집·이용 및 약관 동의",
        level: 2,
      }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /이 기기/ })).toBeNull();

    const submit = screen.getByRole("button", { name: "필수 동의 후 계속" });
    expect(submit).toBeDisabled();
    await user.click(screen.getByLabelText(/\[필수\] 개인정보 수집·이용/));
    expect(submit).toBeDisabled();
    await user.click(screen.getByLabelText(/\[필수\] 서비스 이용약관/));
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(
      await screen.findByRole("button", { name: /이 기기/ }),
    ).toBeVisible();
  });

  it("enrolls a passkey then clears the flag and continues", async () => {
    const user = userEvent.setup();
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

    const session: AuthSession = {
      access_token: "a",
      requires_passkey_setup: true,
    };

    renderApp("/onboarding", makeAuthContext({ session, clearPasskeySetup }));

    await user.click(await screen.findByRole("button", { name: /이 기기/ }));

    await waitFor(() => {
      expect(clearPasskeySetup).toHaveBeenCalledTimes(1);
    });
    // The "this device" option must request the platform authenticator (Touch ID /
    // Windows Hello) while keeping the credential discoverable for usernameless login.
    const arg = create.mock.calls[0][0] as {
      publicKey: PublicKeyCredentialCreationOptions;
    };
    const selection = arg.publicKey.authenticatorSelection;
    expect(selection?.authenticatorAttachment).toBe("platform");
    expect(selection?.residentKey).toBe("required");
  });

  it("does not leave setup blocked when desktop QR approval expires after enrollment", async () => {
    const user = userEvent.setup();
    const clearPasskeySetup = vi.fn();
    const approveToken = `mnt_dla_${"f".repeat(64)}`;
    const approveSession = vi.fn();
    window.sessionStorage.setItem("mnt.desktop_approve", approveToken);
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
    vi.stubGlobal("navigator", {
      credentials: { create: vi.fn().mockResolvedValue(new FakeCredential()), get: vi.fn() },
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
      http.post(
        "*/api/v1/auth/device-login/approve-session",
        async ({ request }) => {
          approveSession(await request.json());
          return HttpResponse.json(
            { error: { code: "UNAUTHORIZED", message: "expired" } },
            { status: 401 },
          );
        },
      ),
    );

    renderApp(
      "/onboarding",
      makeAuthContext({
        session: { access_token: "a", requires_passkey_setup: true },
        clearPasskeySetup,
      }),
    );

    await user.click(await screen.findByRole("button", { name: /이 기기/ }));

    await waitFor(() => {
      expect(approveSession).toHaveBeenCalledWith({
        approve_token: approveToken,
      });
    });
    await waitFor(() => {
      expect(clearPasskeySetup).toHaveBeenCalledTimes(1);
    });
    expect(window.sessionStorage.getItem("mnt.desktop_approve")).toBeNull();
  });

  it("offers exactly the this-device and phone-QR enrollment methods", async () => {
    usePrivacyConsentHandlers(true);
    renderApp(
      "/onboarding",
      makeAuthContext({
        session: {
          access_token: "a",
          requires_passkey_setup: true,
        },
      }),
    );
    // Exactly two reliable methods; the flaky native cross-device hybrid is gone.
    expect(
      await screen.findByRole("button", { name: /이 기기/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /휴대폰으로 등록/ }),
    ).toBeTruthy();
    // The removed native hybrid / "use a phone" options must not reappear.
    expect(
      screen.queryByRole("button", { name: /보안 키|데스크톱 \+ 휴대폰/ }),
    ).toBeNull();
  });

  it("detects phone-QR enrollment completion on the desktop", async () => {
    const user = userEvent.setup();
    let handoffCalls = 0;
    const clearPasskeySetup = vi.fn();
    const acceptTokens = vi.fn();
    usePrivacyConsentHandlers(true);
    server.use(
      http.post("*/api/v1/auth/passkey/enroll-handoff", () => {
        handoffCalls += 1;
        return HttpResponse.json({
          otp: "Abcd1234",
          expires_at: "2026-06-14T00:05:00Z",
          enroll_url:
            "https://console.knllogistic.com/login#otp=Abcd1234&desktop_approve=mnt_dla_" +
            "d".repeat(64),
          poll_token: `mnt_dlp_${"e".repeat(64)}`,
        });
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

    renderApp(
      "/onboarding",
      makeAuthContext({
        session: { access_token: "a", requires_passkey_setup: true },
        acceptTokens,
        clearPasskeySetup,
      }),
    );

    await user.click(
      await screen.findByRole("button", { name: /휴대폰으로 등록/ }),
    );

    // The handoff is minted and the fallback enrollment link is shown.
    const link = await screen.findByRole("link");
    await waitFor(() => {
      expect(handoffCalls).toBe(1);
    });
    expect(link.getAttribute("href")).toBe(
      "https://console.knllogistic.com/login#otp=Abcd1234&desktop_approve=mnt_dla_" +
        "d".repeat(64),
    );
    await waitFor(() => {
      expect(clearPasskeySetup).toHaveBeenCalledTimes(1);
    });
    expect(acceptTokens).toHaveBeenCalledWith({
      access_token: "phone-qr-desktop-access",
      requires_passkey_setup: false,
    });
  });

  it("prefills and clears the OTP panel from a scanned fragment link", async () => {
    window.history.replaceState(null, "", "/login#otp=Abcd1234");
    renderApp("/login#otp=Abcd1234", makeAuthContext({}));
    const field = await screen.findByLabelText(/일회용 코드/);
    expect(field).toHaveValue("Abcd1234");
    await waitFor(() => {
      expect(window.location.hash).toBe("");
    });
  });

  it("ignores query-string OTP links so handoff codes are not accepted from logged URLs", async () => {
    renderApp("/login?otp=Abcd1234", makeAuthContext({}));
    expect(
      await screen.findByRole("button", { name: /일회용 코드로 로그인/ }),
    ).toBeTruthy();
  });

  it("ignores a malformed fragment OTP", async () => {
    renderApp("/login#otp=not-valid", makeAuthContext({}));
    // The login card renders; the OTP panel stays collapsed (reveal button shown).
    expect(
      await screen.findByRole("button", { name: /일회용 코드로 로그인/ }),
    ).toBeTruthy();
  });
});
