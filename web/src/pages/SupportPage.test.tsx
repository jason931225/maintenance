import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter, useNavigate } from "react-router";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createConsoleApiClient } from "../api/client";
import type { ConsoleApiClient } from "../api/client";
import { WindowManagerProvider } from "../console/window";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { ticketCode } from "../features/support/support-format";
import { KO_CONSOLE_SUPPORTDESK as D } from "../features/support/supportdesk-ko.test";
import { KO_CONSOLE_SUPPORTSLO as T } from "../features/support/supportslo-ko.test";
import { supportSloStringsFilled } from "../features/support/supportslo-strings";
import { ko } from "../i18n/ko";
import { SupportPage } from "./SupportPage";

const E = supportSloStringsFilled().engine;

const NOW_ISH_BRANCH = "00000000-0000-4000-8000-000000000001";

// COMPLAINT target is 4h — a ticket created a day ago with no due date is an
// SLO breach derived purely from the ACTIVE setting object.
const breachedTicket = {
  id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
  branch_id: NOW_ISH_BRANCH,
  origin: "CUSTOMER",
  category: "COMPLAINT",
  priority: "HIGH",
  status: "OPEN",
  title: "지게차 리프트 고장 재발",
  requester_user_id: "00000000-0000-4000-8000-0000000000aa",
  requester_name: "고객사",
  assignee_user_id: null,
  assignee_name: null,
  due_at: null,
  created_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  updated_at: new Date().toISOString(),
  resolved_at: null,
  closed_at: null,
};

// OTHER target is 48h — a fresh, already-assigned ticket is inside its SLO.
const onTimeTicket = {
  ...breachedTicket,
  id: "cccccccc-3333-4333-8333-cccccccccccc",
  category: "OTHER",
  title: "기타 문의",
  assignee_user_id: "00000000-0000-4000-8000-0000000000bb",
  assignee_name: "김담당",
  created_at: new Date().toISOString(),
};

const staleTicketId = "dddddddd-4444-4444-8444-dddddddddddd";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<undefined>((next) => {
    resolve = () => {
      next(undefined);
    };
  });
  return { promise, resolve };
}

function SupportHistoryControls() {
  const navigate = useNavigate();
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void navigate("/support");
        }}
      >
        base support
      </button>
      <button
        type="button"
        onClick={() => {
          void navigate(`/support?ticket=${onTimeTicket.id}`);
        }}
      >
        known support ticket
      </button>
      <button
        type="button"
        onClick={() => {
          void navigate(-1);
        }}
      >
        support back
      </button>
      <button
        type="button"
        onClick={() => {
          void navigate(1);
        }}
      >
        support forward
      </button>
    </>
  );
}

interface CommentRow {
  id: string;
  ticket_id: string;
  author_user_id: string | null;
  author_name: string | null;
  body: string;
  is_internal_note: boolean;
  created_at: string;
}

// Captured by the list handler so filter-chip tests can assert the real query.
let lastListQuery = new URLSearchParams();
// Comments posted through the real REST during a test run.
let postedComments: CommentRow[] = [];

const server = setupServer(
  http.get("*/api/v1/support/tickets", ({ request }) => {
    lastListQuery = new URL(request.url).searchParams;
    return HttpResponse.json({
      items: [breachedTicket, onTimeTicket],
      next_cursor: null,
      total: 2,
    });
  }),
  http.get("*/api/v1/support/tickets/:id", ({ params }) => {
    const ticket =
      params.id === breachedTicket.id
        ? breachedTicket
        : params.id === onTimeTicket.id
          ? onTimeTicket
          : undefined;
    return ticket
      ? HttpResponse.json({
          ticket,
          comments: postedComments.filter(
            (comment) => comment.ticket_id === params.id,
          ),
        })
      : HttpResponse.json({ error: "not found" }, { status: 404 });
  }),
  http.post(
    "*/api/v1/support/tickets/:id/comments",
    async ({ params, request }) => {
      const body = (await request.json()) as {
        body: string;
        is_internal_note: boolean;
      };
      const comment: CommentRow = {
        id: `c-${String(postedComments.length + 1)}`,
        ticket_id: String(params.id),
        author_user_id: adminSession.user_id,
        author_name: adminSession.display_name,
        body: body.body,
        is_internal_note: body.is_internal_note,
        created_at: new Date().toISOString(),
      };
      postedComments.push(comment);
      return HttpResponse.json(comment);
    },
  ),
  // SloSettingsCard → real support_slo_setting engine instances (be2-config-objects).
  http.get("*/api/v1/ontology/object-types/:key", ({ params }) =>
    HttpResponse.json({
      object_type: {
        id: "slo-type",
        stable_key: params.key,
        title: "SLO 설정",
        backing_kind: "instance",
        schema_version: 1,
        lifecycle_state: "published",
      },
      title_property_key: "ticket_type",
      backing_table: null,
      primary_key_property: null,
      properties: [],
      links: [],
      actions: [],
      analytics: [],
    }),
  ),
  http.get("*/api/v1/ontology/instances", () => HttpResponse.json([])),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  postedComments = [];
});
afterAll(() => {
  server.close();
});

const adminSession: AuthSession = {
  access_token: "test-token",
  user_id: "00000000-0000-4000-8000-000000000002",
  display_name: "관리자A",
  roles: ["ADMIN"],
  branches: [NOW_ISH_BRANCH],
};

function makeSupportAuthContext(
  session: AuthSession,
  api: ConsoleApiClient,
): AuthContextValue {
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

function renderSupportPage(
  session: AuthSession = adminSession,
  initialEntry = "/support",
  api: ConsoleApiClient = createConsoleApiClient(session.access_token),
) {
  const ctx = makeSupportAuthContext(session, api);
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <WindowManagerProvider>
          <SupportPage />
          <SupportHistoryControls />
        </WindowManagerProvider>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("SupportPage SLO surface", () => {
  it("opens the exact ticket from a direct URL after reload", async () => {
    const first = renderSupportPage(
      adminSession,
      `/support?ticket=${onTimeTicket.id}`,
    );
    expect(
      await screen.findByRole("region", { name: onTimeTicket.title }),
    ).toBeVisible();
    first.unmount();

    renderSupportPage(adminSession, `/support?ticket=${onTimeTicket.id}`);
    expect(
      await screen.findByRole("region", { name: onTimeTicket.title }),
    ).toBeVisible();
  });

  it("distinguishes a stale ticket link from a transport failure", async () => {
    const stale = renderSupportPage(
      adminSession,
      `/support?ticket=${staleTicketId}`,
    );
    expect(await screen.findByText(ko.support.focusedMissing)).toBeVisible();
    stale.unmount();

    server.use(
      http.get("*/api/v1/support/tickets/:id", () =>
        HttpResponse.json({ error: "offline" }, { status: 503 }),
      ),
    );
    renderSupportPage(adminSession, `/support?ticket=${staleTicketId}`);
    expect(
      await screen.findByText(ko.support.focusedUnavailable),
    ).toBeVisible();
    expect(
      screen.queryByText(ko.support.focusedMissing),
    ).not.toBeInTheDocument();
  });

  it("never flashes an old ticket-link result across removal and browser history", async () => {
    const user = userEvent.setup();
    renderSupportPage(adminSession, `/support?ticket=${onTimeTicket.id}`);
    expect(
      await screen.findByRole("region", { name: onTimeTicket.title }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "base support" }));
    expect(
      screen.queryByRole("region", { name: onTimeTicket.title }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "known support ticket" }),
    );
    expect(
      await screen.findByRole("region", { name: onTimeTicket.title }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "support back" }));
    expect(
      screen.queryByRole("region", { name: onTimeTicket.title }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "support forward" }));
    expect(
      await screen.findByRole("region", { name: onTimeTicket.title }),
    ).toBeVisible();
  });

  it("replaces a same-id ticket only with the current session authority result", async () => {
    const oldRequest = deferred();
    const replacement = { ...onTimeTicket, title: "새 권한의 기타 문의" };
    let detailReads = 0;
    server.use(
      http.get("*/api/v1/support/tickets/:id", async () => {
        detailReads += 1;
        if (detailReads === 1) {
          await oldRequest.promise;
          return HttpResponse.json(
            { error: "old authority offline" },
            { status: 503 },
          );
        }
        return HttpResponse.json({ ticket: replacement, comments: [] });
      }),
    );
    const api = createConsoleApiClient("shared-api-token");
    const authorityA = {
      ...adminSession,
      client_session_incarnation: "support-authority-a",
    };
    const authorityB = {
      ...adminSession,
      client_session_incarnation: "support-authority-b",
    };
    const initialEntry = `/support?ticket=${onTimeTicket.id}`;
    const tree = (session: AuthSession) => {
      const ctx: AuthContextValue = {
        ...makeSupportAuthContext(session, api),
      };
      return (
        <AuthContext.Provider value={ctx}>
          <MemoryRouter initialEntries={[initialEntry]}>
            <WindowManagerProvider>
              <SupportPage />
            </WindowManagerProvider>
          </MemoryRouter>
        </AuthContext.Provider>
      );
    };
    const view = render(tree(authorityA));
    await waitFor(() => {
      expect(detailReads).toBe(1);
    });

    view.rerender(tree(authorityB));
    expect(
      screen.queryByRole("region", { name: onTimeTicket.title }),
    ).not.toBeInTheDocument();
    oldRequest.resolve();
    await waitFor(() => {
      expect(detailReads).toBeGreaterThanOrEqual(2);
    });
    expect(
      await screen.findByRole("region", { name: replacement.title }),
    ).toBeVisible();

    await waitFor(() => {
      expect(
        screen.queryByText(ko.support.focusedUnavailable),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole("region", { name: replacement.title }),
    ).toBeVisible();
  });

  it("derives breach alerts and chips from the ACTIVE SLO setting", async () => {
    renderSupportPage();

    // Alert section (internal alert, §4-26): only the breached ticket rows.
    const alerts = await screen.findByRole("alert", { name: T.alerts.title });
    expect(alerts).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: T.alerts.rowAria(breachedTicket.title),
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", {
        name: T.alerts.rowAria(onTimeTicket.title),
      }),
    ).toBeNull();
    // The row escalates per the setting: COMPLAINT → 관리자.
    expect(
      screen.getByText(T.alerts.escalateTo(T.settings.targets.ADMIN)),
    ).toBeVisible();

    // Stat tile is SLO-labelled (never SLA). The breach alerts and chips derive
    // from the local ACTIVE setting and are available to every /support viewer,
    // independent of the RoleManage-gated settings card asserted separately below.
    expect(screen.getByText(T.urgentOrBreached)).toBeVisible();
  });

  it("renders the SLO settings card only for the RoleManage (SUPER_ADMIN) tier", async () => {
    // The card reads/writes the support_slo_setting ontology object, whose REST
    // API is RoleManage-gated (SUPER_ADMIN). The card mounts for that tier and
    // its title (from the English ENGINE_FALLBACK until ko.console.supportslo.
    // engine is wired) renders.
    renderSupportPage({ ...adminSession, roles: ["SUPER_ADMIN"] });
    expect(await screen.findByText(E.title)).toBeVisible();
  });

  it("hides the SLO settings card below the RoleManage tier so no 403 fetch fires", async () => {
    // An ADMIN lacks RoleManage; the ontology read would 403. Deny-by-omission:
    // the card never renders (and never fires the doomed mount fetch).
    renderSupportPage();
    // Wait for the page to settle via a role-independent surface, then assert
    // the card is absent.
    await screen.findByRole("alert", { name: T.alerts.title });
    expect(screen.queryByText(E.title)).toBeNull();
  });

  it("opens the breached ticket from its alert row as the right pin", async () => {
    const user = userEvent.setup();
    renderSupportPage();

    await user.click(
      await screen.findByRole("button", {
        name: T.alerts.rowAria(breachedTicket.title),
      }),
    );

    // §4.7-3: the detail opens as the pinned right panel, not an inline column.
    const panel = await screen.findByRole("region", {
      name: breachedTicket.title,
    });
    await waitFor(() => {
      expect(
        within(panel).getByText(ko.support.transition.title),
      ).toBeVisible();
    });
    // SUP- object code chip + SLO timer chip derived from the ACTIVE setting.
    expect(
      within(panel).getByText(ticketCode(breachedTicket.id)),
    ).toBeVisible();
    expect(
      within(panel).getByText(new RegExp(`^${D.sloOverdueBy("")}`)),
    ).toBeVisible();
  });

  it("escalates per the ACTIVE setting via an audited internal note", async () => {
    const user = userEvent.setup();
    renderSupportPage();

    await user.click(
      await screen.findByRole("button", {
        name: T.alerts.rowAria(breachedTicket.title),
      }),
    );
    const panel = await screen.findByRole("region", {
      name: breachedTicket.title,
    });
    const escalate = await within(panel).findByRole("button", {
      name: T.alerts.escalateTo(T.settings.targets.ADMIN),
    });
    await user.click(escalate);

    // The note posted through the real comments REST shows up in the thread.
    const note = D.escalationNote(T.settings.targets.ADMIN);
    await waitFor(() => {
      expect(within(panel).getByText(note)).toBeVisible();
    });
    expect(postedComments.at(-1)).toMatchObject({
      body: note,
      is_internal_note: true,
      ticket_id: breachedTicket.id,
    });
  });

  it("drills the list from the stat strip", async () => {
    const user = userEvent.setup();
    renderSupportPage();

    // Both tickets are listed before any drill.
    expect(await screen.findByText(onTimeTicket.title)).toBeVisible();

    // 미배정 drill: only the unassigned (breached) ticket remains listed.
    await user.click(
      screen.getByRole("button", {
        name: D.drill(ko.support.command.unassigned),
      }),
    );
    expect(screen.queryByText(onTimeTicket.title)).toBeNull();

    // Pressing the same stat again clears the drill.
    await user.click(
      screen.getByRole("button", {
        name: D.drill(ko.support.command.unassigned),
      }),
    );
    expect(await screen.findByText(onTimeTicket.title)).toBeVisible();
  });

  it("omits the deleted eyebrow and explanatory copy", async () => {
    renderSupportPage();
    await screen.findByText(onTimeTicket.title);

    // §4-12: the CX Operations caption block and explanatory subtitles were
    // deleted from ko.ts — assert no literal survives in the rendered page.
    expect(screen.queryByText(/CX Operations/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText("사내 문의와 고객 접수 요청을 한 곳에서 처리합니다."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("문의, SLA, 담당, 보고를 한 화면에서 처리합니다."),
    ).not.toBeInTheDocument();
  });

  it("filters server-side through the status chip segment", async () => {
    const user = userEvent.setup();
    renderSupportPage();
    await screen.findByText(onTimeTicket.title);

    const statusGroup = screen.getByRole("group", {
      name: ko.support.filters.status,
    });
    const chip = within(statusGroup).getByRole("button", {
      name: ko.support.ticketStatus.IN_PROGRESS,
    });
    await user.click(chip);
    await waitFor(
      () => {
        expect(lastListQuery.get("status")).toBe("IN_PROGRESS");
      },
      { timeout: 5000 },
    );
    expect(chip).toHaveAttribute("aria-pressed", "true");

    // Toggling the same chip off clears the facet. The cleared-query URL is
    // identical to the initial load, so the client's read cache may serve it —
    // prove the facet cleared server-side via the next distinct request: a
    // priority chip click must carry priority WITHOUT the stale status.
    await user.click(chip);
    await waitFor(() => {
      expect(chip).toHaveAttribute("aria-pressed", "false");
    });
    await user.click(
      within(
        screen.getByRole("group", { name: ko.support.filters.priority }),
      ).getByRole("button", { name: ko.support.ticketPriority.URGENT }),
    );
    await waitFor(
      () => {
        expect(lastListQuery.get("priority")).toBe("URGENT");
      },
      { timeout: 5000 },
    );
    expect(lastListQuery.get("status")).toBeNull();
  });
});
