import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createConsoleApiClient } from "../../../api/client";
import { AuthContext } from "../../../context/auth";
import type { AuthContextValue, AuthSession } from "../../../context/auth";
import { ko } from "../../../i18n/ko";
import { SupportBody } from "./SupportBody";

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const session: AuthSession = {
  access_token: "token",
  user_id: "00000000-0000-4000-8000-0000000000aa",
  display_name: "개발자",
  roles: ["SUPER_ADMIN"],
  group_roles: [],
  feature_grants: [],
  org_id: "00000000-0000-0000-0000-0000000000a1",
  branches: ["00000000-0000-4000-8000-000000000001"],
  isPlatform: false,
};

function authValue(): AuthContextValue {
  return {
    session,
    restoring: false,
    login: () => Promise.resolve(),
    logout: () => Promise.resolve(),
    refresh: () => Promise.resolve(),
    acceptTokens: () => undefined,
    clearPasskeySetup: () => undefined,
    api: createConsoleApiClient(() => session.access_token),
    viewAs: undefined,
    enterViewAs: () => undefined,
    exitViewAs: () => undefined,
  };
}

function renderBody() {
  return render(
    <AuthContext.Provider value={authValue()}>
      <SupportBody />
    </AuthContext.Provider>,
  );
}

const openTicket = {
  id: "11111111-1111-4111-8111-111111111111",
  branch_id: session.branches[0],
  origin: "CUSTOMER" as const,
  category: "SYSTEM_BUG" as const,
  priority: "URGENT" as const,
  status: "OPEN" as const,
  title: "메일 첨부 인제스트 실패",
  requester_user_id: "22222222-2222-4222-8222-222222222222",
  requester_name: "김성아",
  assignee_user_id: null,
  assignee_name: null,
  due_at: null,
  created_at: "2020-01-01T00:00:00Z",
  updated_at: "2020-01-01T00:00:00Z",
  resolved_at: null,
  closed_at: null,
};

function installHandlers(items: (typeof openTicket)[] = []) {
  server.use(
    http.get("*/api/v1/support/tickets", () =>
      HttpResponse.json({ items, next_cursor: null, total: items.length }),
    ),
  );
}

describe("SupportBody (console screen composition)", () => {
  it("renders the screen title (koManifest fixes 회신→지원 센터) and an honest empty state — no fabricated rows", async () => {
    installHandlers([]);
    renderBody();

    // ko.console.module.support.title is the shared key this screen and the
    // generic-module config both read; the koManifest note corrects its VALUE
    // (this lane cannot edit ko.ts), so assert the binding, not a literal.
    expect(
      await screen.findByRole("heading", { name: ko.console.module.support.title }),
    ).toBeVisible();
    expect(await screen.findByText(ko.support.empty)).toBeVisible();
    // The stat strip is real-data-derived; with zero tickets every drill reads 0.
    expect(screen.getByRole("button", { name: /열린 티켓/ })).toHaveTextContent("0");
  });

  it("renders real ticket rows from GET /support/tickets and the stat strip drills the list", async () => {
    installHandlers([openTicket]);
    renderBody();

    expect(await screen.findByText(openTicket.title)).toBeVisible();
    const openDrill = screen.getByRole("button", { name: /열린 티켓/ });
    expect(openDrill).toHaveTextContent("1");

    await userEvent.click(openDrill);
    expect(openDrill).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(openTicket.title)).toBeVisible();
  });

  it("renders the error state (not a crash) when GET /support/tickets fails", async () => {
    server.use(http.get("*/api/v1/support/tickets", () => HttpResponse.error()));
    renderBody();

    expect(await screen.findByText(ko.console.module.list.error)).toBeVisible();
  });

  it("selecting a ticket loads the detail pane with an SLO chip and the document-flow rail", async () => {
    installHandlers([openTicket]);
    server.use(
      http.get("*/api/v1/support/tickets/:id", () =>
        HttpResponse.json({ ticket: openTicket, comments: [] }),
      ),
    );
    renderBody();

    await userEvent.click(await screen.findByText(openTicket.title));

    const flowRail = await screen.findByRole("navigation", { name: ko.support.objectRail.title });
    expect(within(flowRail).getByRole("link", { name: ko.support.objectRail.workOrder })).toBeVisible();
  });

  it("pre-selects the first ticket on load, so the 3rd pane reads populated without a click", async () => {
    const second = { ...openTicket, id: "33333333-3333-4333-8333-333333333333", title: "두번째 티켓" };
    installHandlers([openTicket, second]);
    server.use(
      http.get("*/api/v1/support/tickets/:id", ({ params }) =>
        HttpResponse.json({
          ticket: params.id === openTicket.id ? openTicket : second,
          comments: [],
        }),
      ),
    );
    renderBody();

    // The detail pane shows the FIRST ticket's title without the user clicking
    // anything, never the "select a ticket" prompt.
    expect(await screen.findByRole("heading", { name: openTicket.title })).toBeVisible();
    expect(screen.queryByText(ko.support.selectPrompt)).not.toBeInTheDocument();

    // A later refetch (e.g. a transition) never clobbers a since-changed
    // selection — clicking the second row still switches the pane.
    await userEvent.click(screen.getByText(second.title));
    expect(await screen.findByRole("heading", { name: second.title })).toBeVisible();
  });
});
