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
    login: overrides.login ?? (async () => {}),
    logout: overrides.logout ?? (async () => {}),
    refresh: overrides.refresh ?? (async () => {}),
    acceptTokens: overrides.acceptTokens ?? (() => {}),
    clearPasskeySetup: overrides.clearPasskeySetup ?? (() => {}),
    api,
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
      expect(acceptTokens).toHaveBeenCalledWith({
        access_token: "otp-access",
        refresh_token: "otp-refresh",
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
});

describe("requires_passkey_setup routing", () => {
  it("forces an OTP-first session into /onboarding", () => {
    const session: AuthSession = {
      access_token: "a",
      refresh_token: "r",
      requires_passkey_setup: true,
    };
    renderApp("/dispatch", makeAuthContext({ session }));

    expect(
      screen.getByRole("heading", { name: "패스키 등록", level: 1 }),
    ).toBeVisible();
  });
});

describe("admin security page gating", () => {
  it("redirects a non-admin away from /settings/security", async () => {
    const session: AuthSession = {
      access_token: "a",
      refresh_token: "r",
      roles: ["MECHANIC"],
    };
    renderApp("/settings/security", makeAuthContext({ session }));

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "관리자 설정" }),
      ).not.toBeInTheDocument();
    });
  });

  it("renders the admin OTP issue form for an admin", () => {
    const session: AuthSession = {
      access_token: "a",
      refresh_token: "r",
      roles: ["ADMIN"],
      branches: ["11111111-1111-4111-8111-111111111111"],
    };
    renderApp("/settings/security", makeAuthContext({ session }));

    expect(
      screen.getByRole("heading", { name: "일회용 로그인 코드 발급", level: 2 }),
    ).toBeVisible();
  });
});

describe("OnboardingPage enrollment", () => {
  it("enrolls a passkey then clears the flag and continues", async () => {
    const user = userEvent.setup();
    const clearPasskeySetup = vi.fn();

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
      refresh_token: "r",
      requires_passkey_setup: true,
    };

    renderApp("/onboarding", makeAuthContext({ session, clearPasskeySetup }));

    await user.click(screen.getByRole("button", { name: /이 데스크톱/ }));

    await waitFor(() => {
      expect(clearPasskeySetup).toHaveBeenCalledTimes(1);
    });
    // "이 데스크톱" must request the platform authenticator (Touch ID / Windows Hello)
    // while keeping the credential discoverable for usernameless login.
    const arg = create.mock.calls[0][0] as {
      publicKey: PublicKeyCredentialCreationOptions;
    };
    const selection = arg.publicKey.authenticatorSelection;
    expect(selection?.authenticatorAttachment).toBe("platform");
    expect(selection?.residentKey).toBe("required");
  });

  it("offers desktop, mobile, and QR cross-device passkey methods", () => {
    renderApp(
      "/onboarding",
      makeAuthContext({
        session: {
          access_token: "a",
          refresh_token: "r",
          requires_passkey_setup: true,
        },
      }),
    );
    expect(screen.getByRole("button", { name: /이 데스크톱/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /휴대폰에 패스키/ })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /데스크톱 \+ 휴대폰/ }),
    ).toBeTruthy();
  });
});
