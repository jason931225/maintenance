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

const me = {
  id: "me",
  display_name: "Cold Start Admin",
  phone: null,
  team: "MANAGEMENT",
  roles: ["SUPER_ADMIN"],
  branch_ids: [],
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
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

describe("ProfilePage", () => {
  it("loads the current profile and saves a new display name", async () => {
    const user = userEvent.setup();
    const saved = vi.fn();
    server.use(
      http.get("*/api/v1/users/me", () => HttpResponse.json(me)),
      http.patch("*/api/v1/users/me", async ({ request }) => {
        saved(await request.json());
        return HttpResponse.json({ ...me, display_name: "김민식" });
      }),
    );

    renderApp(
      "/settings/profile",
      makeAuthContext({ access_token: "a", roles: ["SUPER_ADMIN"] }),
    );

    const nameInput = await screen.findByLabelText("이름");
    expect(nameInput).toHaveValue("Cold Start Admin");

    await user.clear(nameInput);
    await user.type(nameInput, "김민식");
    await user.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => {
      expect(saved).toHaveBeenCalledWith({
        display_name: "김민식",
        phone: null,
      });
    });
    expect(await screen.findByText("프로필을 저장했습니다.")).toBeVisible();
  });

  it("blocks saving with an empty name", async () => {
    const user = userEvent.setup();
    server.use(http.get("*/api/v1/users/me", () => HttpResponse.json(me)));

    renderApp(
      "/settings/profile",
      makeAuthContext({ access_token: "a", roles: ["MECHANIC"] }),
    );

    const nameInput = await screen.findByLabelText("이름");
    await user.clear(nameInput);
    await user.click(screen.getByRole("button", { name: "저장" }));

    expect(await screen.findByText("이름을 입력하세요.")).toBeVisible();
  });
});
