import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AuthContext } from "../../context/auth";
import type { AuthContextValue, AuthSession } from "../../context/auth";
import { createConsoleApiClient } from "../../api/client";
import { ko } from "../../i18n/ko";
import { PageHeader } from "./PageHeader";
import { AppShell } from "./AppShell";
import { FEATURES } from "./nav";
import { CONSOLE_TOAST_EVENT } from "./useConsoleToast";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  server.resetHandlers();
  vi.useRealTimers();
});
afterAll(() => {
  server.close();
});

function makeAuthContext(roles: string[], featureGrants: string[] = []): AuthContextValue {
  const session: AuthSession = {
    access_token: "test-token",
    user_id: "user-1",
    display_name: "테스터",
    roles,
    branches: [],
    feature_grants: featureGrants,
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

function StubPage({ title, marker }: { title: string; marker: string }) {
  return (
    <>
      <PageHeader title={title} />
      <p>{marker}</p>
    </>
  );
}

function renderShell(
  roles: string[],
  initialPath: string | { pathname: string; state?: unknown } = "/dispatch",
  featureGrants: string[] = [],
) {
  return render(
    <AuthContext.Provider value={makeAuthContext(roles, featureGrants)}>
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
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

function openCommandPalette() {
  fireEvent.keyDown(document, { key: "k", ctrlKey: true });
  return screen.getByRole("dialog", { name: "명령 팔레트" });
}

describe("AppShell navigation fabric", () => {
  it("opens Cmd-K navigation and preserves the back-stack breadcrumb", async () => {
    const user = userEvent.setup();
    renderShell(["ADMIN"]);

    expect(await screen.findByText("dispatch page")).toBeVisible();
    const dialog = openCommandPalette();

    await user.type(within(dialog).getByLabelText("명령 검색"), "장비");
    await user.click(within(dialog).getByRole("button", { name: /장비 조회/ }));

    expect(await screen.findByText("equipment page")).toBeVisible();
    const breadcrumbs = screen.getByRole("navigation", { name: "이동 경로" });
    expect(within(breadcrumbs).getByRole("link", { name: "배차" })).toHaveAttribute(
      "href",
      "/dispatch",
    );
    expect(within(breadcrumbs).getByText("장비 조회")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("seeds breadcrumbs from command-palette navigation across shell remounts", async () => {
    renderShell(["ADMIN"], {
      pathname: "/equipment",
      state: {
        backStackSeed: {
          href: "/work-hub",
          pathname: "/work-hub",
          label: "forged label",
        },
      },
    });

    expect(await screen.findByText("equipment page")).toBeVisible();
    const breadcrumbs = await screen.findByRole("navigation", { name: "이동 경로" });
    expect(within(breadcrumbs).queryByText("forged label")).not.toBeInTheDocument();
    expect(within(breadcrumbs).getByRole("link", { name: "업무 허브" })).toHaveAttribute(
      "href",
      "/work-hub",
    );
    expect(within(breadcrumbs).getByText("장비 조회")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("ignores unsafe breadcrumb seed links from location state", async () => {
    renderShell(["ADMIN"], {
      pathname: "/equipment",
      state: {
        backStackSeed: {
          href: "https://example.invalid/work-hub",
          pathname: "/work-hub",
          label: "업무 허브",
        },
      },
    });

    expect(await screen.findByText("equipment page")).toBeVisible();
    const breadcrumbs = await screen.findByRole("navigation", { name: "이동 경로" });
    expect(within(breadcrumbs).queryByRole("link", { name: "업무 허브" })).not.toBeInTheDocument();
    expect(within(breadcrumbs).getByText("장비 조회")).toHaveAttribute(
      "aria-current",
      "page",
    );
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
    const approvals = within(nav).getByRole("link", { name: /전자결제/ });

    expect(await within(messenger).findByText("5")).toBeVisible();
    expect(await within(mail).findByText("5")).toBeVisible();
    expect(await within(support).findByText("1")).toBeVisible();
    expect(await within(support).findByText("2")).toBeVisible();
    expect(await within(approvals).findByText("3")).toBeVisible();
    expect(support).toHaveAccessibleName(/읽지 않은 문의 1건, 열린 티켓 2건/);

    // The topbar bell is now a rail toggle (UI-M2b) — the legacy dropdown was
    // retired in favour of the comms rail 알림 section. It carries only the
    // notification unread badge; the count breakdown lives in the rail.
    const header = screen.getByRole("banner");
    expect(
      within(header).getByRole("button", {
        name: ko.shell.commsRail.openNotifications,
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("dialog", { name: ko.shell.notifications.title }),
    ).not.toBeInTheDocument();
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

  it("hosts console toasts and lets undo close the toast", async () => {
    const user = userEvent.setup();
    const undo = vi.fn();
    renderShell(["ADMIN"]);

    window.dispatchEvent(
      new CustomEvent(CONSOLE_TOAST_EVENT, {
        detail: { message: "AP-3124 상신 완료", onUndo: undo },
      }),
    );

    expect(await screen.findByRole("status")).toHaveTextContent("AP-3124 상신 완료");

    await user.click(screen.getByRole("button", { name: ko.console.toast.undo }));

    expect(undo).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
