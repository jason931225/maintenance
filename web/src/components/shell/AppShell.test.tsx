import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AuthContext, useAuth } from "../../context/auth";
import type { AuthContextValue, AuthSession, ViewAsState } from "../../context/auth";
import { createConsoleApiClient } from "../../api/client";
import { useWindowManager } from "../../console/window";
import { ko } from "../../i18n/ko";
import { PageHeader } from "./PageHeader";
import { AppShell } from "./AppShell";
import { FEATURES } from "./nav";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  server.resetHandlers();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});
afterAll(() => {
  server.close();
});

function makeAuthContext(
  roles: string[],
  featureGrants: string[] = [],
  orgId = "tenant-default",
  sessionOverrides: Partial<AuthSession> = {},
): AuthContextValue {
  const session: AuthSession = {
    access_token: "test-token",
    client_session_incarnation: "test-session",
    user_id: "user-1",
    display_name: "테스터",
    roles,
    branches: [],
    org_id: orgId,
    feature_grants: featureGrants,
    ...sessionOverrides,
  };
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

function makeViewAsAuthContext(
  sourceOverrides: Partial<AuthSession> = {},
  effectiveOverrides: Partial<AuthSession> = {},
): AuthContextValue {
  const effectiveToken = effectiveOverrides.access_token ?? "view-token-a";
  const auth = makeAuthContext(["ADMIN"], [], "tenant-a", {
    access_token: effectiveToken,
    client_session_incarnation: "view-session",
    user_id: "operator-1",
    branches: ["tenant-branch"],
    ...effectiveOverrides,
  });
  const viewAs: ViewAsState = {
    token: effectiveToken,
    client_session_incarnation: "view-session",
    actingOrgId: "tenant-a",
    actingOrgName: "Tenant A",
    actingRole: "ADMIN",
    mode: "MANAGE",
    source: "PLATFORM",
    platformSession: {
      access_token: "source-token-a",
      client_session_incarnation: "source-session",
      org_id: "platform-org",
      user_id: "operator-1",
      roles: ["SUPER_ADMIN"],
      group_roles: ["GROUP_ADMIN"],
      feature_grants: ["tenant_manage"],
      branches: ["source-branch"],
      isPlatform: true,
      ...sourceOverrides,
    },
  };
  return { ...auth, viewAs };
}

type SessionWithClientIncarnation = AuthSession & {
  client_session_incarnation?: string;
};

function withSessionIncarnation(
  auth: AuthContextValue,
  incarnation: string,
): AuthContextValue {
  if (auth.session) {
    (auth.session as SessionWithClientIncarnation).client_session_incarnation =
      incarnation;
  }
  return auth;
}

function withViewAsIncarnations(
  auth: AuthContextValue,
  effectiveIncarnation: string,
  sourceIncarnation: string,
): AuthContextValue {
  withSessionIncarnation(auth, effectiveIncarnation);
  if (auth.viewAs) {
    (
      auth.viewAs.platformSession as SessionWithClientIncarnation
    ).client_session_incarnation = sourceIncarnation;
  }
  return auth;
}

function StubPage({ title, marker }: { title: string; marker: string }) {
  return (
    <>
      <PageHeader title={title} />
      <p>{marker}</p>
    </>
  );
}

function WindowStubPage() {
  const { entries, open, minimize, register, saveLayout } = useWindowManager();
  const { session } = useAuth();
  const navigate = useNavigate();
  const branchSnapshot = (session?.branches ?? []).join(",") || "none";
  return (
    <>
      <p data-testid="window-entry-count">{String(entries.size)}</p>
      <button
        type="button"
        onClick={() => {
          open({
            id: "WO-1",
            title: "패널 A",
            render: () => (
              <>
                <p>panel body</p>
                <p>{`panel scope ${branchSnapshot}`}</p>
              </>
            ),
          });
        }}
      >
        open-window
      </button>
      <button
        type="button"
        onClick={() => {
          open({
            id: "WO-2",
            title: "패널 B",
            render: () => (
              <>
                <p>second panel body</p>
                <p>{`second panel scope ${branchSnapshot}`}</p>
              </>
            ),
          });
        }}
      >
        open-second-window
      </button>
      <button
        type="button"
        onClick={() => {
          minimize("WO-1");
        }}
      >
        minimize-window
      </button>
      <button
        type="button"
        onClick={() => {
          register({
            id: "WO-1",
            title: "패널 A",
            render: () => <p>panel body</p>,
          });
        }}
      >
        register-window
      </button>
      <button type="button" onClick={() => { saveLayout(); }}>
        save-window-layout
      </button>
      <button type="button" onClick={() => { void navigate("/equipment"); }}>
        navigate-window
      </button>
    </>
  );
}

function shellTree(auth: AuthContextValue, initialPath = "/dispatch") {
  return (
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route
              path="/dispatch"
              element={<StubPage title="작업지시 목록" marker="dispatch page" />}
            />
            <Route
              path="/equipment"
              element={<StubPage title="장비 조회" marker="equipment page" />}
            />
            <Route
              path="/settings/policy"
              element={<StubPage title="권한 정책" marker="policy page" />}
            />
            <Route path="/window-stub" element={<WindowStubPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

function renderShell(roles: string[], initialPath = "/dispatch", featureGrants: string[] = []) {
  return render(shellTree(makeAuthContext(roles, featureGrants), initialPath));
}

function openCommandPalette() {
  fireEvent.keyDown(document, { key: "k", ctrlKey: true });
  return screen.getByRole("dialog", { name: "명령 팔레트" });
}

describe("AppShell navigation fabric", () => {
  it("opens Cmd-K navigation between screens", async () => {
    const user = userEvent.setup();
    renderShell(["ADMIN"]);

    expect(await screen.findByText("dispatch page")).toBeVisible();
    const dialog = openCommandPalette();

    await user.type(within(dialog).getByLabelText("명령 검색"), "장비");
    await user.click(within(dialog).getByRole("button", { name: /장비 조회/ }));

    expect(await screen.findByText("equipment page")).toBeVisible();
    // The redundant breadcrumb strip is gone — the page <h1> is the single
    // title source.
    expect(
      screen.queryByRole("navigation", { name: ko.shell.breadcrumbs.label }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "장비 조회" }),
    ).toBeVisible();
  });

  it("uses the same role-gated nav registry for command visibility", () => {
    renderShell(["MECHANIC"]);

    const dialog = openCommandPalette();

    expect(
      within(dialog).queryByRole("button", { name: /권한 정책/ }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: /장비 조회/ }),
    ).toBeVisible();
  });

  it("renders the personal department group before restricted operations and assets", () => {
    renderShell(["ADMIN"]);

    const nav = screen.getByRole("navigation", { name: "메인 내비게이션" });
    const groupLabels = within(nav)
      .getAllByText(/개인\/부서 업무|물류·정비 운영|장비·영업/)
      .map((node) => node.textContent);
    expect(groupLabels).toEqual([
      "개인/부서 업무",
      "물류·정비 운영",
      "장비·영업",
    ]);
  });

  it("surfaces privileged commands only to permitted roles", () => {
    renderShell(["SUPER_ADMIN"]);

    const dialog = openCommandPalette();

    expect(
      within(dialog).getByRole("button", { name: /권한 정책/ }),
    ).toBeVisible();
  });

  it("does not surface RoleManage-tier commands from stale feature_grants alone", () => {
    renderShell(["MEMBER"], "/dispatch", [FEATURES.ROLE_MANAGE]);

    const dialog = openCommandPalette();

    expect(
      within(dialog).queryByRole("button", { name: /권한 정책/ }),
    ).not.toBeInTheDocument();
  });

  it("shows unread messenger, mail, support, and e-approval counts in the left nav", async () => {
    server.use(
      http.get("*/api/approval-items", () =>
        HttpResponse.json({
          items: [
            { status: "REQUESTED" },
            { status: "APPROVED" },
          ],
          sources: [
            { key: "workOrders", label: "작업 보고", status: "ok", count: 2 },
            { key: "dailyPlans", label: "계획업무", status: "ok", count: 1 },
          ],
          limit: 100,
          offset: 0,
          total: 3,
        }),
      ),
      http.get("*/api/messenger/threads", () =>
        HttpResponse.json({
          items: [
            { unread_count: 2 },
            { unread_count: 3 },
            { unread_count: 0 },
          ],
        }),
      ),
      http.get("*/api/v1/mail/folders", () =>
        HttpResponse.json([
          { id: "inbox", kind: "INBOX", name: "Inbox", unread_count: 4, total_count: 10 },
          { id: "archive", kind: "ARCHIVE", name: "Archive", unread_count: 1, total_count: 8 },
        ]),
      ),
      http.get("*/api/v1/support/tickets", () =>
        HttpResponse.json({
          items: [
            { id: "open-1", status: "OPEN", origin: "CUSTOMER" },
            { id: "hold-1", status: "ON_HOLD", origin: "INTERNAL" },
            { id: "closed-1", status: "CLOSED", origin: "CUSTOMER" },
          ],
        }),
      ),
    );

    renderShell(["ADMIN"], "/dispatch", [FEATURES.MAIL_USE]);

    const nav = screen.getByRole("navigation", { name: "메인 내비게이션" });
    const messenger = within(nav).getByRole("link", { name: /메신저/ });
    const mail = within(nav).getByRole("link", { name: /메일함/ });
    const support = within(nav).getByRole("link", { name: /고객지원/ });
    const approvals = within(nav).getByRole("link", { name: /전자결재시스템/ });

    expect(await within(messenger).findByText("5")).toBeVisible();
    expect(await within(mail).findByText("5")).toBeVisible();
    expect(await within(support).findByText("1")).toBeVisible();
    expect(await within(support).findByText("2")).toBeVisible();
    expect(await within(approvals).findByText("3")).toBeVisible();
    expect(support).toHaveAccessibleName(/읽지 않은 문의 1건, 열린 티켓 2건/);

    fireEvent.click(
      await screen.findByRole("button", { name: ko.shell.notifications.open }),
    );
    const notifications = screen.getByRole("dialog", {
      name: ko.shell.notifications.title,
    });
    expect(within(notifications).getByText(ko.shell.notifications.approvals)).toBeVisible();
    expect(within(notifications).getByText(ko.shell.notifications.messages)).toBeVisible();
    expect(within(notifications).getByText(ko.shell.notifications.mail)).toBeVisible();
    expect(within(notifications).getByText(ko.shell.notifications.supportUnread)).toBeVisible();
    expect(
      within(notifications).queryByText(ko.shell.notifications.submittedDocuments),
    ).not.toBeInTheDocument();
    expect(
      within(notifications).queryByText(ko.shell.notifications.completedApprovals),
    ).not.toBeInTheDocument();
    expect(
      within(notifications).queryByText(ko.shell.notifications.supportOpen),
    ).not.toBeInTheDocument();
    expect(
      within(notifications)
        .getByText(ko.shell.notifications.supportUnread)
        .closest("button"),
    ).toHaveTextContent("1");
  });

  it("keeps keyboard focus inside the command palette", async () => {
    const user = userEvent.setup();
    renderShell(["ADMIN"]);

    const dialog = openCommandPalette();

    await waitFor(() => {
      expect(within(dialog).getByLabelText("명령 검색")).toHaveFocus();
    });
    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it("closes the command palette on Escape from a result button", async () => {
    renderShell(["ADMIN"]);

    const dialog = openCommandPalette();
    const equipment = within(dialog).getByRole("button", { name: /장비 조회/ });
    equipment.focus();
    fireEvent.keyDown(equipment, { key: "Escape" });

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "명령 팔레트" }),
      ).not.toBeInTheDocument();
    });
  });
});

describe("AppShell chrome", () => {
  function stubWideViewport() {
    vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
      matches: query === "(min-width: 1440px)",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList);
  }

  it("defaults the comms rail open on wide viewports and persists the toggle", () => {
    stubWideViewport();
    const view = renderShell(["ADMIN"]);

    const rail = screen.getByRole("complementary", { name: ko.commsRail.label });
    fireEvent.click(within(rail).getByRole("button", { name: ko.commsRail.close }));

    expect(
      screen.queryByRole("complementary", { name: ko.commsRail.label }),
    ).not.toBeInTheDocument();
    expect(window.localStorage.getItem("oyatie.console.commsRail.open")).toBe("0");

    // The saved personal setting wins over the viewport default on next mount.
    view.unmount();
    renderShell(["ADMIN"]);
    expect(
      screen.queryByRole("complementary", { name: ko.commsRail.label }),
    ).not.toBeInTheDocument();
  });

  it("keeps the comms rail collapsed by default below the wide breakpoint", () => {
    renderShell(["ADMIN"]);
    expect(
      screen.queryByRole("complementary", { name: ko.commsRail.label }),
    ).not.toBeInTheDocument();
  });

  it("opens the command palette from the persistent quick-actions dock", () => {
    renderShell(["ADMIN"]);

    fireEvent.click(
      screen.getByRole("button", { name: ko.shell.dock.quickActions }),
    );

    expect(screen.getByRole("dialog", { name: "명령 팔레트" })).toBeVisible();
  });

  it("preserves windows across same-authority navigation and clears them synchronously on authority change", () => {
    const authA = makeAuthContext(["ADMIN"], [], "tenant-a");
    const authB = makeAuthContext(["ADMIN"], [], "tenant-b");
    const view = render(shellTree(authA, "/window-stub"));

    fireEvent.click(screen.getByRole("button", { name: "open-window" }));
    expect(screen.getByText("panel body")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "navigate-window" }));
    expect(screen.getByText("equipment page")).toBeVisible();
    expect(screen.getByText("panel body")).toBeVisible();

    view.rerender(shellTree(authB, "/window-stub"));
    expect(screen.queryByText("panel body")).not.toBeInTheDocument();
  });

  it("preserves windows when branch claims only reorder or duplicate", () => {
    const authA = makeAuthContext(["ADMIN"], [], "tenant-a", {
      branches: ["branch-b", "branch-a", "branch-a"],
    });
    const authB = makeAuthContext(["ADMIN"], [], "tenant-a", {
      branches: ["branch-a", "branch-b"],
    });
    const view = render(shellTree(authA, "/window-stub"));

    fireEvent.click(screen.getByRole("button", { name: "open-window" }));
    view.rerender(shellTree(authB, "/window-stub"));

    expect(screen.getByText("panel body")).toBeVisible();
  });

  it("preserves windows across access-token rotation", () => {
    const authA = makeAuthContext(["ADMIN"], [], "tenant-a", {
      access_token: "token-a",
      branches: ["branch-a"],
    });
    const authB = makeAuthContext(["ADMIN"], [], "tenant-a", {
      access_token: "token-b",
      branches: ["branch-a"],
    });
    const view = render(shellTree(authA, "/window-stub"));

    fireEvent.click(screen.getByRole("button", { name: "open-window" }));
    view.rerender(shellTree(authB, "/window-stub"));

    expect(screen.getByText("panel body")).toBeVisible();
  });

  it("session incarnation clears a pinned missing-user replacement synchronously", () => {
    const authA = withSessionIncarnation(
      makeAuthContext(["ADMIN"], [], "tenant-a", {
        access_token: "missing-user-a",
        user_id: undefined,
      }),
      "direct-a",
    );
    const authB = withSessionIncarnation(
      makeAuthContext(["ADMIN"], [], "tenant-a", {
        access_token: "missing-user-b",
        user_id: undefined,
      }),
      "direct-b",
    );
    const view = render(shellTree(authA, "/window-stub"));

    fireEvent.click(screen.getByRole("button", { name: "open-window" }));
    expect(screen.getByText("panel body")).toBeVisible();

    view.rerender(shellTree(authB, "/window-stub"));

    expect(screen.queryByText("panel body")).not.toBeInTheDocument();
    expect(screen.getByTestId("window-entry-count")).toHaveTextContent("0");
  });

  it("session incarnation clears a minimized missing-org replacement and retained tray closure synchronously", () => {
    const authA = withSessionIncarnation(
      makeAuthContext(["ADMIN"], [], "tenant-a", {
        access_token: "missing-org-a",
        org_id: undefined,
      }),
      "direct-a",
    );
    const authB = withSessionIncarnation(
      makeAuthContext(["ADMIN"], [], "tenant-a", {
        access_token: "missing-org-b",
        org_id: undefined,
      }),
      "direct-b",
    );
    const view = render(shellTree(authA, "/window-stub"));

    fireEvent.click(screen.getByRole("button", { name: "open-window" }));
    fireEvent.click(screen.getByRole("button", { name: "minimize-window" }));
    expect(screen.getByRole("button", { name: "패널 A 복원" })).toBeVisible();

    view.rerender(shellTree(authB, "/window-stub"));

    expect(
      screen.queryByRole("button", { name: "패널 A 복원" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("panel body")).not.toBeInTheDocument();
  });

  it("session incarnation fail-closes replacement when both stable IDs are missing", () => {
    const authA = withSessionIncarnation(
      makeAuthContext(["ADMIN"], [], "tenant-a", {
        access_token: "missing-both-a",
        org_id: undefined,
        user_id: undefined,
      }),
      "direct-a",
    );
    const authB = withSessionIncarnation(
      makeAuthContext(["ADMIN"], [], "tenant-a", {
        access_token: "missing-both-b",
        org_id: undefined,
        user_id: undefined,
      }),
      "direct-b",
    );
    const view = render(shellTree(authA, "/window-stub"));

    fireEvent.click(screen.getByRole("button", { name: "open-window" }));
    view.rerender(shellTree(authB, "/window-stub"));

    expect(screen.queryByText("panel body")).not.toBeInTheDocument();
  });

  it("custom context fail-closes incomplete identity by weak object partition", () => {
    const authA = makeAuthContext(["ADMIN"], [], "tenant-a", {
      access_token: "custom-a",
      client_session_incarnation: undefined,
      org_id: undefined,
      user_id: undefined,
    });
    const authB = makeAuthContext(["ADMIN"], [], "tenant-a", {
      access_token: "custom-b",
      client_session_incarnation: undefined,
      org_id: undefined,
      user_id: undefined,
    });
    const view = render(shellTree(authA, "/window-stub"));

    fireEvent.click(screen.getByRole("button", { name: "open-window" }));
    view.rerender(shellTree(authB, "/window-stub"));

    expect(screen.queryByText("panel body")).not.toBeInTheDocument();
    expect(screen.getByTestId("window-entry-count")).toHaveTextContent("0");
  });

  it("disables retained window state when a custom context omits an owned incarnation", () => {
    const auth = makeAuthContext(["ADMIN"], [], "tenant-a", {
      access_token: "custom-stable",
      client_session_incarnation: undefined,
      org_id: undefined,
      user_id: undefined,
    });
    const view = render(shellTree(auth, "/window-stub"));

    fireEvent.click(screen.getByRole("button", { name: "open-window" }));
    view.rerender(shellTree(auth, "/window-stub"));

    expect(screen.queryByText("panel body")).not.toBeInTheDocument();
    expect(screen.getByTestId("window-entry-count")).toHaveTextContent("0");
  });

  it("does not infer session continuity from equal populated identity without an incarnation", () => {
    const authA = makeAuthContext(["ADMIN"], ["mail_use"], "tenant-a", {
      access_token: "incarnationless-a",
      client_session_incarnation: undefined,
      branches: ["branch-a"],
    });
    const authB = makeAuthContext(["ADMIN"], ["mail_use"], "tenant-a", {
      access_token: "incarnationless-b",
      client_session_incarnation: undefined,
      branches: ["branch-a"],
    });
    const view = render(shellTree(authA, "/window-stub"));

    fireEvent.click(screen.getByRole("button", { name: "open-window" }));
    expect(screen.queryByText("panel body")).not.toBeInTheDocument();
    expect(screen.getByTestId("window-entry-count")).toHaveTextContent("0");

    view.rerender(shellTree(authB, "/window-stub"));
    expect(screen.queryByText("panel body")).not.toBeInTheDocument();
    expect(screen.getByTestId("window-entry-count")).toHaveTextContent("0");
  });

  it("does not rehydrate saved A window or tray state into equal-claim B", () => {
    const authA = withSessionIncarnation(
      makeAuthContext(["ADMIN"], ["mail_use"], "tenant-a", {
        access_token: "layout-a",
        branches: ["branch-a"],
      }),
      "layout-session-a",
    );
    const authB = withSessionIncarnation(
      makeAuthContext(["ADMIN"], ["mail_use"], "tenant-a", {
        access_token: "layout-b",
        branches: ["branch-a"],
      }),
      "layout-session-b",
    );
    const view = render(shellTree(authA, "/window-stub"));

    fireEvent.click(screen.getByRole("button", { name: "open-window" }));
    fireEvent.click(screen.getByRole("button", { name: "minimize-window" }));
    fireEvent.click(screen.getByRole("button", { name: "save-window-layout" }));
    expect(screen.getByRole("button", { name: "패널 A 복원" })).toBeVisible();

    view.rerender(shellTree(authB, "/window-stub"));
    fireEvent.click(screen.getByRole("button", { name: "register-window" }));

    expect(
      screen.queryByRole("button", { name: "패널 A 복원" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("panel body")).not.toBeInTheDocument();
  });

  it("session incarnation change clears equal populated identity and claims", () => {
    const authA = withSessionIncarnation(
      makeAuthContext(["ADMIN"], ["mail_use"], "tenant-a", {
        access_token: "equal-authority-a",
        branches: ["branch-a"],
      }),
      "direct-a",
    );
    const authB = withSessionIncarnation(
      makeAuthContext(["ADMIN"], ["mail_use"], "tenant-a", {
        access_token: "equal-authority-b",
        branches: ["branch-a"],
      }),
      "direct-b",
    );
    const view = render(shellTree(authA, "/window-stub"));

    fireEvent.click(screen.getByRole("button", { name: "open-window" }));
    view.rerender(shellTree(authB, "/window-stub"));

    expect(screen.queryByText("panel body")).not.toBeInTheDocument();
  });

  it("stable session incarnation preserves navigation, rerender, refresh, and normalized claims", () => {
    const authA = withSessionIncarnation(
      makeAuthContext(
        ["ADMIN", "MECHANIC", "ADMIN"],
        ["mail_use", "dispatch_read", "mail_use"],
        "tenant-a",
        {
          access_token: "stable-refresh-a",
          branches: ["branch-b", "branch-a", "branch-a"],
        },
      ),
      "stable-session",
    );
    const authB = withSessionIncarnation(
      makeAuthContext(
        ["MECHANIC", "ADMIN"],
        ["dispatch_read", "mail_use"],
        "tenant-a",
        {
          access_token: "stable-refresh-b",
          branches: ["branch-a", "branch-b"],
        },
      ),
      "stable-session",
    );
    const view = render(shellTree(authA, "/window-stub"));

    fireEvent.click(screen.getByRole("button", { name: "open-window" }));
    fireEvent.click(screen.getByRole("button", { name: "navigate-window" }));
    expect(screen.getByText("panel body")).toBeVisible();

    view.rerender(shellTree(authB, "/window-stub"));

    expect(screen.getByText("panel body")).toBeVisible();
  });

  it("view-as uses source-user fallback and preserves a stable effective incarnation", () => {
    const authA = withViewAsIncarnations(
      makeViewAsAuthContext({}, {
        access_token: "view-token-a",
        user_id: undefined,
      }),
      "view-session",
      "source-session",
    );
    const authB = withViewAsIncarnations(
      makeViewAsAuthContext(
        { access_token: "source-token-b" },
        {
          access_token: "view-token-b",
          user_id: undefined,
        },
      ),
      "view-session",
      "source-session",
    );
    const view = render(shellTree(authA, "/window-stub"));

    fireEvent.click(screen.getByRole("button", { name: "open-window" }));
    view.rerender(shellTree(authB, "/window-stub"));

    expect(screen.getByText("panel body")).toBeVisible();
  });

  it("view-as source incarnation clears replacement when source stable identity is missing", () => {
    const authA = withViewAsIncarnations(
      makeViewAsAuthContext(
        { org_id: undefined, user_id: undefined },
        { user_id: undefined },
      ),
      "view-session",
      "source-a",
    );
    const authB = withViewAsIncarnations(
      makeViewAsAuthContext(
        {
          access_token: "source-token-b",
          org_id: undefined,
          user_id: undefined,
        },
        { access_token: "view-token-b", user_id: undefined },
      ),
      "view-session",
      "source-b",
    );
    const view = render(shellTree(authA, "/window-stub"));

    fireEvent.click(screen.getByRole("button", { name: "open-window" }));
    view.rerender(shellTree(authB, "/window-stub"));

    expect(screen.queryByText("panel body")).not.toBeInTheDocument();
  });

  it("A-B-A session incarnations do not resurrect removed window state", () => {
    const authA = withSessionIncarnation(
      makeAuthContext(["ADMIN"], [], "tenant-a"),
      "session-a",
    );
    const authB = withSessionIncarnation(
      makeAuthContext(["ADMIN"], [], "tenant-a"),
      "session-b",
    );
    const authAReturn = withSessionIncarnation(
      makeAuthContext(["ADMIN"], [], "tenant-a"),
      "session-a",
    );
    const view = render(shellTree(authA, "/window-stub"));

    fireEvent.click(screen.getByRole("button", { name: "open-window" }));
    view.rerender(shellTree(authB, "/window-stub"));
    expect(screen.queryByText("panel body")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "open-window" }));
    fireEvent.click(screen.getByRole("button", { name: "minimize-window" }));
    expect(screen.getByRole("button", { name: "패널 A 복원" })).toBeVisible();

    view.rerender(shellTree(authAReturn, "/window-stub"));

    expect(
      screen.queryByRole("button", { name: "패널 A 복원" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("panel body")).not.toBeInTheDocument();
  });

  it("window partition output contains no raw, digested, or reversible token material", () => {
    const accessToken = "opaque-secret-token-material";
    const tokenDigest =
      "f859daea54282132e61ac9cb7d95553d32540a2072bb164e31e03c2fa2988c22";
    const reversibleToken = btoa(accessToken);
    const stringify = vi.spyOn(JSON, "stringify");
    const logOutput: string[] = [];
    const logSpies = [
      vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
        logOutput.push(values.map(String).join(" "));
      }),
      vi.spyOn(console, "warn").mockImplementation((...values: unknown[]) => {
        logOutput.push(values.map(String).join(" "));
      }),
      vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
        logOutput.push(values.map(String).join(" "));
      }),
    ];

    const view = render(
      shellTree(
        withSessionIncarnation(
          makeAuthContext(["ADMIN"], [], "tenant-a", {
            access_token: accessToken,
          }),
          "non-secret-session",
        ),
      ),
    );
    const serialized = stringify.mock.results.flatMap((result) =>
      result.type === "return" && typeof result.value === "string"
        ? [result.value]
        : [],
    );
    const exposed = [
      view.container.innerHTML,
      ...serialized,
      ...logOutput,
      JSON.stringify(Object.entries(localStorage)),
      JSON.stringify(Object.entries(sessionStorage)),
    ].join("\n");

    for (const forbidden of [accessToken, tokenDigest, reversibleToken]) {
      expect(exposed).not.toContain(forbidden);
    }
    for (const spy of logSpies) spy.mockRestore();
    stringify.mockRestore();
  });

  it("clears all windows and retained branch closures synchronously when branch scope changes", () => {
    const authA = makeAuthContext(["ADMIN"], [], "tenant-a", {
      branches: ["branch-a"],
    });
    const authB = makeAuthContext(["ADMIN"], [], "tenant-a", {
      branches: ["branch-b"],
    });
    const view = render(shellTree(authA, "/window-stub"));

    fireEvent.click(screen.getByRole("button", { name: "open-window" }));
    expect(screen.getByText("panel scope branch-a")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "open-second-window" }));
    expect(screen.getByText("second panel scope branch-a")).toBeVisible();
    expect(screen.getByRole("button", { name: "패널 A 복원" })).toBeVisible();

    view.rerender(shellTree(authB, "/window-stub"));

    expect(screen.queryByText("second panel body")).not.toBeInTheDocument();
    expect(screen.queryByText("second panel scope branch-a")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "패널 A 복원" })).not.toBeInTheDocument();
  });

  const sourceAuthorityChanges: Array<[string, Partial<AuthSession>]> = [
    ["organization", { org_id: "other-platform-org" }],
    ["user", { user_id: "operator-2" }],
    ["roles", { roles: ["PLATFORM_AUDITOR"] }],
    ["group roles", { group_roles: ["GROUP_AUDITOR"] }],
    ["feature grants", { feature_grants: ["tenant_read"] }],
    ["branches", { branches: ["other-source-branch"] }],
    ["platform status", { isPlatform: false }],
  ];

  it.each(sourceAuthorityChanges)(
    "clears persistent windows when view-as source %s changes",
    (_claim, sourceOverrides) => {
      const authA = makeViewAsAuthContext();
      const authB = makeViewAsAuthContext(sourceOverrides);
      const view = render(shellTree(authA, "/window-stub"));

      fireEvent.click(screen.getByRole("button", { name: "open-window" }));
      expect(screen.getByText("panel body")).toBeVisible();

      view.rerender(shellTree(authB, "/window-stub"));

      expect(screen.queryByText("panel body")).not.toBeInTheDocument();
    },
  );

  it("preserves windows when all view-as source set claims only reorder or duplicate", () => {
    const authA = makeViewAsAuthContext({
      roles: ["SUPER_ADMIN", "PLATFORM_AUDITOR", "SUPER_ADMIN"],
      group_roles: ["GROUP_AUDITOR", "GROUP_ADMIN", "GROUP_ADMIN"],
      feature_grants: ["tenant_read", "tenant_manage", "tenant_manage"],
      branches: ["source-b", "source-a", "source-a"],
    });
    const authB = makeViewAsAuthContext({
      roles: ["PLATFORM_AUDITOR", "SUPER_ADMIN"],
      group_roles: ["GROUP_ADMIN", "GROUP_AUDITOR"],
      feature_grants: ["tenant_manage", "tenant_read"],
      branches: ["source-a", "source-b"],
    });
    const view = render(shellTree(authA, "/window-stub"));

    fireEvent.click(screen.getByRole("button", { name: "open-window" }));
    view.rerender(shellTree(authB, "/window-stub"));

    expect(screen.getByText("panel body")).toBeVisible();
  });

  it("preserves windows across effective, view-as, and source token-only rotation", () => {
    const authA = makeViewAsAuthContext();
    const authB = makeViewAsAuthContext(
      { access_token: "source-token-b" },
      { access_token: "view-token-b" },
    );
    const view = render(shellTree(authA, "/window-stub"));

    fireEvent.click(screen.getByRole("button", { name: "open-window" }));
    view.rerender(shellTree(authB, "/window-stub"));

    expect(screen.getByText("panel body")).toBeVisible();
  });

  it("hosts the single minimized-window tray in the bottom dock", () => {
    renderShell(["ADMIN"], "/window-stub");

    fireEvent.click(screen.getByRole("button", { name: "open-window" }));
    expect(screen.getByText("panel body")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "minimize-window" }));
    expect(screen.queryByText("panel body")).not.toBeInTheDocument();

    // Exactly one tray (the dock-hosted one — no floating duplicate).
    const trays = screen.getAllByRole("group", { name: ko.console.window.tray });
    expect(trays).toHaveLength(1);

    fireEvent.click(
      within(trays[0]).getByRole("button", { name: "패널 A 복원" }),
    );
    expect(screen.getByText("panel body")).toBeVisible();
  });
});
