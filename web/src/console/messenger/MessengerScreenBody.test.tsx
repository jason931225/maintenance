// Proves the ConsoleShell registry body (MessengerScreenBody) closes the
// blank-plane gap: the shell mounts screen bodies with NO ambient policy
// provider, so without this wrapper `usePolicyGate()` = DENY_ALL and every
// messenger affordance is hidden. The wrapper derives a role gate from the
// session, so a granted role sees the surface and a no-role session is denied
// by omission (heading stays, gated rows vanish). The full data flow is covered
// by MessengerConsoleScreen.test.tsx; this only asserts the gate wiring.
import { render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createConsoleApiClient } from "../../api/client";
import { AuthContext, type AuthContextValue, type AuthSession } from "../../context/auth";
import type { ConsoleMessengerThread } from "./types";
import { MessengerScreenBody } from "./MessengerScreenBody";

const channel: ConsoleMessengerThread = {
  id: "thread-channel",
  kind: "team",
  visibility: "channel",
  muted: false,
  branch_id: "branch-1",
  title: "배차 관제",
  work_order_id: null,
  last_message_id: null,
  last_message_at: "2026-07-09T09:02:00Z",
  member_count: 3,
  unread_count: 0,
  created_at: "2026-07-09T08:00:00Z",
  updated_at: "2026-07-09T09:02:00Z",
};

let memberRequests = 0;

const server = setupServer(
  http.get("*/api/messenger/threads", () => HttpResponse.json({ items: [channel] })),
  http.get("*/api/messenger/channels", () => HttpResponse.json({ items: [channel] })),
  http.get("*/api/messenger/members", () => {
    memberRequests += 1;
    return HttpResponse.json({ items: [] });
  }),
  http.get("*/api/messenger/threads/:threadId/messages", () =>
    HttpResponse.json({ items: [], next_cursor: null }),
  ),
  http.get("*/api/messenger/threads/:threadId/presence", () => HttpResponse.json({ items: [] })),
  http.put("*/api/messenger/threads/:threadId/read-receipt", () => HttpResponse.json({})),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  server.resetHandlers();
  memberRequests = 0;
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
    <MemoryRouter>
      <AuthContext.Provider value={makeAuthContext(session)}>
        <MessengerScreenBody />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe("MessengerScreenBody (ConsoleShell registry body)", () => {
  it("supplies a role gate so a granted session sees the gated thread rows", async () => {
    renderBody({
      access_token: "token",
      roles: ["MECHANIC"],
      feature_grants: [],
      branches: ["branch-1"],
    });

    expect(await screen.findByRole("heading", { name: "메신저" })).toBeVisible();
    // The thread row is PolicyGated on messenger.thread.read — present only
    // because the wrapper's gate is not the DENY_ALL default.
    expect(await screen.findByRole("button", { name: /배차 관제/ })).toBeVisible();
  });

  it("denies by omission for a session with no comms role (heading stays, rows vanish)", async () => {
    renderBody({
      access_token: "token",
      roles: [],
      feature_grants: [],
      branches: ["branch-1"],
    });

    expect(await screen.findByRole("heading", { name: "메신저" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /배차 관제/ })).not.toBeInTheDocument();
  });

  it("fails closed with an explicit branch-selection state instead of an empty member directory", async () => {
    renderBody({ access_token: "token", roles: ["SUPER_ADMIN"], feature_grants: [] });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "메신저를 열 지점을 먼저 선택하세요.",
    );
    expect(memberRequests).toBe(0);
    expect(screen.queryByRole("button", { name: /배차 관제/ })).not.toBeInTheDocument();
  });
});
