// Composition smoke test — AutomateHub itself (rule list, canvas builder, run
// log, version-pending banner) is exhaustively covered by
// pages/AutomatePage.test.tsx; this file only proves AutomateBody mounts it
// correctly under its own BulkPolicyGateProvider (empty/error/loaded states).
import { render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { clearAuthorizeBulkCache } from "../../../api/authorizeBulk";
import { createConsoleApiClient } from "../../../api/client";
import { AuthContext } from "../../../context/auth";
import type { AuthContextValue, AuthSession } from "../../../context/auth";
import { ko } from "../../../i18n/ko";
import { allowAllBulkAuthorize } from "../../../test/policyGateMock";
import { AutomateBody } from "./AutomateBody";

const S = ko.console.automate;

const server = setupServer(allowAllBulkAuthorize());
beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  server.resetHandlers();
  clearAuthorizeBulkCache();
});
afterAll(() => {
  server.close();
});

function sessionWith(roles: readonly string[]): AuthSession {
  return {
    access_token: "token",
    user_id: "00000000-0000-4000-8000-0000000000aa",
    display_name: "개발자",
    roles: [...roles],
    group_roles: [],
    feature_grants: [],
    org_id: "00000000-0000-0000-0000-0000000000a1",
    branches: ["00000000-0000-4000-8000-000000000001"],
    isPlatform: false,
  };
}

function authValue(roles: readonly string[]): AuthContextValue {
  const session = sessionWith(roles);
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

// No injected policy provider — the body owns its own role gate (the R4 fix);
// mounting it bare is what proves SUPER_ADMIN gets tabs while others don't.
function renderBody(roles: readonly string[] = ["SUPER_ADMIN"]) {
  return render(
    <AuthContext.Provider value={authValue(roles)}>
      <AutomateBody />
    </AuthContext.Provider>,
  );
}

function installHandlers(items: unknown[] = []) {
  server.use(
    http.get("*/api/v1/ontology/object-types", () => HttpResponse.json([])),
    http.get("*/api/v1/workflow-studio/definitions", () => HttpResponse.json({ items })),
    http.get("*/api/v1/workflow-studio/definitions/:id/run-log", () =>
      HttpResponse.json({ items: [] }),
    ),
  );
}

describe("AutomateBody (console screen composition)", () => {
  it("mounts the real workflow-studio tabs and an empty rule list — no fabricated rows", async () => {
    installHandlers([]);
    renderBody();

    expect(await screen.findByRole("tab", { name: S.tabs.rules, selected: true })).toBeVisible();
    expect(screen.getByRole("tab", { name: S.tabs.schedules })).toBeVisible();
    expect(screen.getByRole("tab", { name: S.tabs.monitors })).toBeVisible();
    expect(screen.getByText(S.labels.noSelection)).toBeVisible();
  });

  it("renders the error state (not a crash) when GET /definitions fails", async () => {
    server.use(
      http.get("*/api/v1/ontology/object-types", () => HttpResponse.json([])),
      http.get("*/api/v1/workflow-studio/definitions", () => HttpResponse.error()),
    );
    renderBody();

    expect(await screen.findByText(ko.console.workflows.errors.loadFailed)).toBeVisible();
  });

  it("shows no tabs (deny-by-omission) for a role without automate grants", async () => {
    installHandlers([]);
    renderBody(["MEMBER"]);

    // The hub loads, then finds zero viewable tabs → the honest empty chip, and
    // NOT the rule/schedule/monitor tablist.
    expect(await screen.findByText(S.labels.noAvailableTabs)).toBeVisible();
    expect(screen.queryByRole("tab", { name: S.tabs.rules })).toBeNull();
    expect(screen.queryByRole("tab", { name: S.tabs.schedules })).toBeNull();
    expect(screen.queryByRole("tab", { name: S.tabs.monitors })).toBeNull();
  });
});
