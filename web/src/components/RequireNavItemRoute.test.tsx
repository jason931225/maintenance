import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { createConsoleApiClient } from "../api/client";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { FEATURES, ROLES } from "./shell/nav";
import { RequireEquipmentManageRoute } from "./RequireEquipmentManageRoute";
import { RequireNavItemRoute } from "./RequireNavItemRoute";

function makeAuthContext(
  roles: string[],
  featureGrants: string[] = [],
): AuthContextValue {
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

function renderGuardedRoutes(ctx: AuthContextValue, initialPath = "/dispatch") {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route element={<RequireNavItemRoute itemKey="overview" />}>
            <Route path="/overview" element={<div>work hub</div>} />
          </Route>
          <Route path="/mail" element={<div>mail page</div>} />
          <Route element={<RequireNavItemRoute itemKey="dispatch" />}>
            <Route path="/dispatch" element={<div>dispatch page</div>} />
          </Route>
          <Route element={<RequireNavItemRoute itemKey="financial" />}>
            <Route path="/financial" element={<div>financial page</div>} />
          </Route>
          <Route element={<RequireNavItemRoute itemKey="location" />}>
            <Route path="/settings/location" element={<div>location page</div>} />
          </Route>
          <Route path="/equipment" element={<div>equipment browse</div>} />
          <Route
            element={
              <RequireNavItemRoute
                itemKey="equipment-manage"
                redirectTo="/equipment"
              />
            }
          >
            <Route element={<RequireEquipmentManageRoute />}>
              <Route
                path="/equipment/manage"
                element={<div>equipment manage</div>}
              />
            </Route>
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("RequireNavItemRoute", () => {
  it("redirects a mail-only custom member away from logistics direct URLs", () => {
    renderGuardedRoutes(makeAuthContext([ROLES.MEMBER], [FEATURES.MAIL_USE]));

    expect(screen.getByText("mail page")).toBeVisible();
    expect(screen.queryByText("dispatch page")).not.toBeInTheDocument();
  });

  it("redirects a mail-only custom member away from a direct overview URL", () => {
    renderGuardedRoutes(
      makeAuthContext([ROLES.MEMBER], [FEATURES.MAIL_USE]),
      "/overview",
    );

    expect(screen.getByText("mail page")).toBeVisible();
    expect(screen.queryByText("work hub")).not.toBeInTheDocument();
  });

  it("redirects a mail-only custom member away from direct financial and location URLs", () => {
    const mailOnly = makeAuthContext([ROLES.MEMBER], [FEATURES.MAIL_USE]);

    renderGuardedRoutes(mailOnly, "/financial");
    expect(screen.getByText("mail page")).toBeVisible();
    expect(screen.queryByText("financial page")).not.toBeInTheDocument();
  });

  it("redirects a mail-only custom member away from direct location settings", () => {
    renderGuardedRoutes(
      makeAuthContext([ROLES.MEMBER], [FEATURES.MAIL_USE]),
      "/settings/location",
    );

    expect(screen.getByText("mail page")).toBeVisible();
    expect(screen.queryByText("location page")).not.toBeInTheDocument();
  });

  it("allows a logistics feature grant to reach its matching direct URL", () => {
    renderGuardedRoutes(
      makeAuthContext([ROLES.MEMBER], [FEATURES.WORK_ORDER_READ_ALL]),
    );

    expect(screen.getByText("dispatch page")).toBeVisible();
  });

  it("allows an equipment manage feature grant through both route guards", () => {
    renderGuardedRoutes(
      makeAuthContext([ROLES.MEMBER], [FEATURES.EQUIPMENT_MANAGE]),
      "/equipment/manage",
    );

    expect(screen.getByText("equipment manage")).toBeVisible();
  });
});
