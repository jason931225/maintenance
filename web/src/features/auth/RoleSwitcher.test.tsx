import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AuthContext } from "../../context/auth";
import type { AuthContextValue } from "../../context/auth";
import { RoleSwitcher } from "./RoleSwitcher";

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
  overrides: Partial<AuthContextValue> = {},
): AuthContextValue {
  return {
    session: undefined,
    restoring: false,
    login: async () => {},
    logout: async () => {},
    refresh: async () => {},
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    api: {} as AuthContextValue["api"],
    viewAs: undefined,
    enterViewAs: () => {},
    exitViewAs: () => undefined,
    ...overrides,
  };
}

function renderSwitcher(ctx: AuthContextValue) {
  return render(
    <AuthContext.Provider value={ctx}>
      <RoleSwitcher />
    </AuthContext.Provider>,
  );
}

describe("RoleSwitcher", () => {
  it("starts collapsed behind a reveal button", () => {
    renderSwitcher(makeAuthContext());
    expect(
      screen.getByRole("button", { name: /역할 전환 로그인/ }),
    ).toBeVisible();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("mints a session via dev-auth and hands the token to acceptTokens", async () => {
    const user = userEvent.setup();
    const acceptTokens = vi.fn();
    server.use(
      http.post("*/api/v1/dev-auth/session", () =>
        HttpResponse.json({ access_token: "dev-auth-token" }),
      ),
    );

    renderSwitcher(makeAuthContext({ acceptTokens }));

    await user.click(screen.getByRole("button", { name: /역할 전환 로그인/ }));
    await user.click(screen.getByRole("button", { name: "역할로 로그인" }));

    expect(acceptTokens).toHaveBeenCalledWith({
      access_token: "dev-auth-token",
      requires_passkey_setup: false,
    });
  });

  it("shows an error and does not accept a session when the backend rejects the request", async () => {
    const user = userEvent.setup();
    const acceptTokens = vi.fn();
    server.use(
      http.post("*/api/v1/dev-auth/session", () =>
        HttpResponse.json({}, { status: 400 }),
      ),
    );

    renderSwitcher(makeAuthContext({ acceptTokens }));

    await user.click(screen.getByRole("button", { name: /역할 전환 로그인/ }));
    await user.click(screen.getByRole("button", { name: "역할로 로그인" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "역할 전환 로그인에 실패했습니다.",
    );
    expect(acceptTokens).not.toHaveBeenCalled();
  });
});
