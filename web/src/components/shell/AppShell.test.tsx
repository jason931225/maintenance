import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AuthContext } from "../../context/auth";
import type { AuthContextValue, AuthSession } from "../../context/auth";
import { createConsoleApiClient } from "../../api/client";
import { PageHeader } from "./PageHeader";
import { AppShell } from "./AppShell";
import { FEATURES } from "./nav";

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

function renderShell(roles: string[], initialPath = "/dispatch", featureGrants: string[] = []) {
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

    fireEvent.click(await screen.findByRole("button", { name: "개인 알림 열기" }));
    const notifications = screen.getByRole("dialog", { name: "개인별 실시간 알림" });
    expect(within(notifications).getByText("결재할 전자결제")).toBeVisible();
    expect(within(notifications).getByText("상신 전자문서")).toBeVisible();
    expect(within(notifications).getByText("결재완료")).toBeVisible();
    expect(within(notifications).getAllByText("3").length).toBeGreaterThan(0);
    expect(within(notifications).getByText("읽지 않은 고객문의").nextSibling).toHaveTextContent("1");
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
