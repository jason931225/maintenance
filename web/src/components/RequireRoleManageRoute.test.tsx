import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { createConsoleApiClient } from "../api/client";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { RequireRoleManageRoute } from "./RequireRoleManageRoute";
import { FEATURES, ROLES } from "./shell/nav";

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

function renderGuardedPolicy(session: AuthSession) {
  return render(
    <AuthContext.Provider value={makeAuthContext(session)}>
      <MemoryRouter initialEntries={["/settings/policy"]}>
        <Routes>
          <Route path="/work-hub" element={<h1>업무 허브</h1>} />
          <Route element={<RequireRoleManageRoute />}>
            <Route path="/settings/policy" element={<h1>권한 정책</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("RequireRoleManageRoute", () => {
  it("allows SUPER_ADMIN to reach RoleManage-tier policy surfaces", () => {
    renderGuardedPolicy({
      access_token: "token",
      roles: [ROLES.SUPER_ADMIN],
    });

    expect(screen.getByRole("heading", { name: "권한 정책" })).toBeVisible();
  });

  it("fails closed for stale RoleManage feature_grants and advisory Cedar projection data", () => {
    renderGuardedPolicy({
      access_token: "token",
      roles: [ROLES.MEMBER],
      feature_grants: [FEATURES.ROLE_MANAGE],
      policy_projection: {
        policy_version: "old",
        subject_version: "old",
        engine_mode: "cedar_shadow_legacy_enforce",
        stale: true,
        feature_grants: [FEATURES.ROLE_MANAGE],
        elevated_decisions: [FEATURES.ROLE_MANAGE],
      },
    });

    expect(screen.getByRole("heading", { name: "업무 허브" })).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "권한 정책" }),
    ).not.toBeInTheDocument();
  });
});
