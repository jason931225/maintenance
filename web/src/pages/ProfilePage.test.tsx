import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { createConsoleApiClient } from "../api/client";
import { ProfilePage } from "./ProfilePage";

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

function consoleRollout(overrides: Record<string, unknown> = {}) {
  return {
    flag_key: "console_carbon_copy",
    org_enabled: true,
    org_rollout_enabled: true,
    user_opted_in: false,
    legacy_kill_switch_enabled: false,
    kill_switch_active: false,
    effective_new_console: false,
    effective_route: "legacy",
    effective_route_for_opted_in_user: "new_console",
    effective_route_for_opted_out_user: "legacy",
    overrides_individual_toggles: false,
    ...overrides,
  };
}

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

function renderProfile(ctx: AuthContextValue) {
  server.use(http.get("*/api/v1/auth/passkeys", () => HttpResponse.json([])));
  return render(
    <AuthContext.Provider value={ctx}>
      <ProfilePage />
    </AuthContext.Provider>,
  );
}

describe("ProfilePage", () => {
  it("loads the current profile and saves a new display name", async () => {
    const user = userEvent.setup();
    const saved = vi.fn();
    server.use(
      http.get("*/api/v1/users/me", () => HttpResponse.json(me)),
      http.get("*/api/v1/console/rollout", () =>
        HttpResponse.json(consoleRollout()),
      ),
      http.patch("*/api/v1/users/me", async ({ request }) => {
        saved(await request.json());
        return HttpResponse.json({ ...me, display_name: "김민식" });
      }),
    );

    renderProfile(makeAuthContext({ access_token: "a", roles: ["SUPER_ADMIN"] }));

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
    server.use(
      http.get("*/api/v1/users/me", () => HttpResponse.json(me)),
      http.get("*/api/v1/console/rollout", () =>
        HttpResponse.json(consoleRollout()),
      ),
    );

    renderProfile(makeAuthContext({ access_token: "a", roles: ["MECHANIC"] }));

    const nameInput = await screen.findByLabelText("이름");
    await user.clear(nameInput);
    await user.click(screen.getByRole("button", { name: "저장" }));

    expect(await screen.findByText("이름을 입력하세요.")).toBeVisible();
  });

  it("loads and persists the per-user 새 콘솔 opt-in", async () => {
    const user = userEvent.setup();
    const saved = vi.fn();
    server.use(
      http.get("*/api/v1/users/me", () => HttpResponse.json(me)),
      http.get("*/api/v1/console/rollout", () =>
        HttpResponse.json(consoleRollout()),
      ),
      http.put("*/api/v1/console/rollout/opt-in", async ({ request }) => {
        saved(await request.json());
        return HttpResponse.json(
          consoleRollout({
            user_opted_in: true,
            effective_new_console: true,
            effective_route: "new_console",
          }),
        );
      }),
    );

    renderProfile(makeAuthContext({ access_token: "a", roles: ["MECHANIC"] }));

    const toggle = await screen.findByRole("switch", { name: "새 콘솔 사용" });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText("기존 화면")).toBeVisible();

    await user.click(toggle);

    await waitFor(() => {
      expect(saved).toHaveBeenCalledWith({ opt_in: true });
    });
    expect(await screen.findByText("콘솔")).toBeVisible();
    expect(toggle).toBeChecked();
  });

  it("forces the profile rollout toggle to legacy when the org kill switch is active", async () => {
    const user = userEvent.setup();
    const saved = vi.fn();
    server.use(
      http.get("*/api/v1/users/me", () => HttpResponse.json(me)),
      http.get("*/api/v1/console/rollout", () =>
        HttpResponse.json(
          consoleRollout({
            user_opted_in: true,
            legacy_kill_switch_enabled: true,
            kill_switch_active: true,
            effective_new_console: false,
            effective_route: "legacy",
            effective_route_for_opted_in_user: "legacy",
            overrides_individual_toggles: true,
          }),
        ),
      ),
      http.put("*/api/v1/console/rollout/opt-in", async ({ request }) => {
        saved(await request.json());
        return HttpResponse.json(consoleRollout());
      }),
    );

    renderProfile(makeAuthContext({ access_token: "a", roles: ["MECHANIC"] }));

    const toggle = await screen.findByRole("switch", { name: "새 콘솔 사용" });
    expect(toggle).toBeDisabled();
    expect(toggle).not.toBeChecked();
    expect(screen.getByText("기존 화면")).toBeVisible();
    expect(screen.getByText("긴급 차단")).toBeVisible();

    await user.click(toggle);
    expect(saved).not.toHaveBeenCalled();
  });

  it("does not show pending-member help when a MEMBER session has group-admin access", async () => {
    server.use(
      http.get("*/api/v1/users/me", () =>
        HttpResponse.json({ ...me, roles: ["MEMBER"] }),
      ),
      http.get("*/api/v1/console/rollout", () =>
        HttpResponse.json(consoleRollout()),
      ),
    );

    renderProfile(
      makeAuthContext({
        access_token: "a",
        roles: ["MEMBER"],
        group_roles: ["GROUP_ADMIN"],
      }),
    );

    expect(await screen.findByLabelText("이름")).toBeVisible();
    expect(
      screen.queryByText(
        "권한이 부여되기 전까지 일부 기능은 사용할 수 없습니다. 관리자에게 문의하세요.",
      ),
    ).not.toBeInTheDocument();
  });
});
