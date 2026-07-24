// Proves the ConsoleShell registry body (MailScreenBody) closes the blank-plane
// gap: MailScreen wraps its ENTIRE surface in `<PolicyGated action={mail.use}>`,
// and the shell mounts screen bodies with NO ambient policy provider, so without
// this wrapper the gate = DENY_ALL default and the whole mailbox (title + all)
// renders nothing. The wrapper derives a role gate from the session. Full webmail
// data flow is covered by MailScreen.test.tsx; this only asserts the gate wiring.
import { render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";

import { createConsoleApiClient } from "../../api/client";
import { AuthContext, type AuthContextValue, type AuthSession } from "../../context/auth";
import { ko } from "../../i18n/ko";
import { MailScreenBody } from "./MailScreenBody";

const MAIL_TITLE = ko.console.mail.title;

const server = setupServer(
  http.get("*/api/v1/mail/account", () =>
    HttpResponse.json({ address: "me@cossok.com", provisioned: true }),
  ),
  http.get("*/api/v1/mail/folders", () => HttpResponse.json([])),
  http.get("*/api/v1/mail/threads", () => HttpResponse.json([])),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

function makeAuthContext(session: AuthSession): AuthContextValue {
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
    api: createConsoleApiClient(session.access_token),
  };
}

function renderBody(session: AuthSession) {
  return render(
    <AuthContext.Provider value={makeAuthContext(session)}>
      <MemoryRouter initialEntries={["/console/mail"]}>
        <MailScreenBody />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("MailScreenBody (ConsoleShell registry body)", () => {
  it("supplies a role gate so a granted session sees the mailbox surface", async () => {
    renderBody({ access_token: "token", roles: ["MEMBER"], feature_grants: [] });

    // The whole screen sits behind PolicyGated(mail.use); a visible title proves
    // the wrapper's gate is not the DENY_ALL default.
    expect(await screen.findByRole("heading", { name: MAIL_TITLE })).toBeVisible();
  });

  it("denies by omission for a session with no comms role (blank plane)", async () => {
    renderBody({ access_token: "token", roles: [], feature_grants: [] });

    // Give the mount + fetch a tick; the gate stays closed so nothing renders.
    await Promise.resolve();
    expect(screen.queryByRole("heading", { name: MAIL_TITLE })).not.toBeInTheDocument();
  });
});
