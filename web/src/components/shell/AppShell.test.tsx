import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AuthContext } from "../../context/auth";
import type { AuthContextValue, AuthSession } from "../../context/auth";
import { createConsoleApiClient } from "../../api/client";
import { PageHeader } from "./PageHeader";
import { AppShell } from "./AppShell";

function makeAuthContext(roles: string[]): AuthContextValue {
  const session: AuthSession = {
    access_token: "test-token",
    user_id: "user-1",
    display_name: "테스터",
    roles,
    branches: [],
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

function renderShell(roles: string[], initialPath = "/dispatch") {
  return render(
    <AuthContext.Provider value={makeAuthContext(roles)}>
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

  it("surfaces privileged commands only to permitted roles", () => {
    renderShell(["SUPER_ADMIN"]);

    const dialog = openCommandPalette();

    expect(
      within(dialog).getByRole("button", { name: /권한 정책/ }),
    ).toBeVisible();
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
