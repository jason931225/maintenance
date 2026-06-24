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

const account = {
  id: "m1",
  display_name: "정비팀",
  email_address: "service@example.com",
  from_name: "정비팀",
  imap_host: "imap.example.com",
  imap_port: 993,
  imap_security: "SSL_TLS",
  imap_username: "service@example.com",
  smtp_host: "smtp.example.com",
  smtp_port: 465,
  smtp_security: "SSL_TLS",
  smtp_username: "service@example.com",
  has_smtp_password: true,
  has_imap_password: true,
  status: "ACTIVE",
};

function makeAuthContext(session: AuthSession): AuthContextValue {
  const api = createConsoleApiClient(session.access_token);
  return {
    session,
    restoring: false,
    login: async () => {},
    logout: async () => {},
    refresh: async () => {},
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    viewAs: undefined,
    enterViewAs: () => {},
    exitViewAs: () => undefined,
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

const adminSession: AuthSession = { access_token: "a", roles: ["ADMIN"] };

describe("EmailSettingsPage", () => {
  it("redirects a non-admin away from /settings/email", async () => {
    renderApp(
      "/settings/email",
      makeAuthContext({ access_token: "a", roles: ["RECEPTIONIST"] }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "메일 서버" }),
      ).not.toBeInTheDocument();
    });
  });

  it("loads the existing config: shows 설정됨 and leaves the password blank", async () => {
    server.use(
      http.get("*/api/v1/mail/account", () => HttpResponse.json(account)),
    );

    renderApp("/settings/email", makeAuthContext(adminSession));

    // The host is pre-filled from the stored view.
    expect(await screen.findByDisplayValue("smtp.example.com")).toBeVisible();
    // Each sealed credential surfaces a "설정됨" indicator.
    expect(screen.getAllByText("설정됨").length).toBe(2);
    // The write-only password fields stay blank — the secret is never returned.
    const passwordInputs = screen.getAllByLabelText("비밀번호");
    for (const input of passwordInputs) {
      expect(input).toHaveValue("");
    }
  });

  it("renders the empty first-time form on a 204", async () => {
    server.use(
      http.get(
        "*/api/v1/mail/account",
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    renderApp("/settings/email", makeAuthContext(adminSession));

    // The form renders; the host is empty and no "설정됨" indicator is present.
    expect(
      await screen.findByLabelText("표시 이름"),
    ).toHaveValue("");
    expect(screen.queryByText("설정됨")).not.toBeInTheDocument();
  });

  it("renders the not-configured-server state on a 503", async () => {
    server.use(
      http.get("*/api/v1/mail/account", () =>
        HttpResponse.json(
          { error: { code: "email_not_configured", message: "x" } },
          { status: 503 },
        ),
      ),
    );

    renderApp("/settings/email", makeAuthContext(adminSession));

    expect(
      await screen.findByText("메일 기능이 아직 구성되지 않았습니다."),
    ).toBeVisible();
    // The configuration form is not rendered in this state.
    expect(screen.queryByLabelText("표시 이름")).not.toBeInTheDocument();
  });

  it("saves via PUT and omits an unchanged (blank) password", async () => {
    const user = userEvent.setup();
    const saved = vi.fn();
    server.use(
      http.get("*/api/v1/mail/account", () => HttpResponse.json(account)),
      http.put("*/api/v1/mail/account", async ({ request }) => {
        saved(await request.json());
        return HttpResponse.json(account);
      }),
    );

    renderApp("/settings/email", makeAuthContext(adminSession));

    await screen.findByDisplayValue("smtp.example.com");
    await user.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => {
      expect(saved).toHaveBeenCalledTimes(1);
    });
    const body = saved.mock.calls[0][0];
    // The keep-existing path: a blank password field must NOT send a password.
    expect(body).not.toHaveProperty("smtp_password");
    expect(body).not.toHaveProperty("imap_password");
    expect(body).toMatchObject({
      display_name: "정비팀",
      email_address: "service@example.com",
      smtp_host: "smtp.example.com",
      smtp_port: 465,
      smtp_security: "SSL_TLS",
      imap_host: "imap.example.com",
      imap_port: 993,
    });
  });

  it("sends the password only when a new value is entered", async () => {
    const user = userEvent.setup();
    const saved = vi.fn();
    server.use(
      http.get("*/api/v1/mail/account", () => HttpResponse.json(account)),
      http.put("*/api/v1/mail/account", async ({ request }) => {
        saved(await request.json());
        return HttpResponse.json(account);
      }),
    );

    renderApp("/settings/email", makeAuthContext(adminSession));

    await screen.findByDisplayValue("smtp.example.com");
    // Type a new SMTP password (the first of the two password inputs).
    const passwordInputs = screen.getAllByLabelText("비밀번호");
    await user.type(passwordInputs[0], "new-secret");
    await user.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => {
      expect(saved).toHaveBeenCalledTimes(1);
    });
    const body = saved.mock.calls[0][0] as Record<string, unknown>;
    expect(body.smtp_password).toBe("new-secret");
    // The IMAP password was left blank → still omitted.
    expect(body).not.toHaveProperty("imap_password");
  });

  it("shows a success banner when the connection test passes", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/v1/mail/account", () => HttpResponse.json(account)),
      http.post("*/api/v1/mail/account/test", () =>
        HttpResponse.json({ ok: true }),
      ),
    );

    renderApp("/settings/email", makeAuthContext(adminSession));

    await screen.findByDisplayValue("smtp.example.com");
    await user.click(screen.getByRole("button", { name: "연결 테스트" }));

    expect(
      await screen.findByText("SMTP 서버에 정상적으로 연결되었습니다."),
    ).toBeVisible();
  });

  it("maps a structured error_code to friendly Korean copy", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/v1/mail/account", () => HttpResponse.json(account)),
      http.post("*/api/v1/mail/account/test", () =>
        HttpResponse.json({ ok: false, error_code: "auth_failed" }),
      ),
    );

    renderApp("/settings/email", makeAuthContext(adminSession));

    await screen.findByDisplayValue("smtp.example.com");
    await user.click(screen.getByRole("button", { name: "연결 테스트" }));

    expect(
      await screen.findByText("사용자 이름 또는 비밀번호가 올바르지 않습니다."),
    ).toBeVisible();
    // The raw error_code token is never surfaced to the user.
    expect(screen.queryByText(/auth_failed/)).not.toBeInTheDocument();
  });
});
