// Composition smoke test — AutomateHub itself (rule list, canvas builder, run
// log, version-pending banner) is exhaustively covered by
// pages/AutomatePage.test.tsx; this file only proves AutomateBody mounts it
// correctly under its own BulkPolicyGateProvider (empty/error/loaded states).
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";

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
function RouterProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</output>
      <button type="button" onClick={() => void navigate(-1)}>
        history back
      </button>
      <button type="button" onClick={() => void navigate(1)}>
        history forward
      </button>
    </>
  );
}

function renderBody(
  roles: readonly string[] = ["SUPER_ADMIN"],
  initialEntries: string[] = ["/console/workflow"],
) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AuthContext.Provider value={authValue(roles)}>
        <AutomateBody />
      </AuthContext.Provider>
      <RouterProbe />
    </MemoryRouter>,
  );
}

function expectLocation(expected: string) {
  expect(screen.getByTestId("location").textContent).toBe(expected);
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

  it.each([
    ["/console/workflow", "rules"],
    ["/console/scheduled", "schedules"],
  ] as const)("direct load and reload of %s retain the route-authoritative %s tab", async (path, tab) => {
    installHandlers([]);
    const selectedLabel = tab === "rules" ? S.tabs.rules : S.tabs.schedules;

    const firstLoad = renderBody(["SUPER_ADMIN"], [path]);
    expect(await screen.findByRole("tab", { name: selectedLabel, selected: true })).toBeVisible();
    firstLoad.unmount();

    renderBody(["SUPER_ADMIN"], [path]);
    expect(await screen.findByRole("tab", { name: selectedLabel, selected: true })).toBeVisible();
    expectLocation(path);
  });

  it("writes tab changes to history and follows browser back and forward", async () => {
    installHandlers([]);
    renderBody();

    expect(await screen.findByRole("tab", { name: S.tabs.rules, selected: true })).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: S.tabs.schedules }));
    expectLocation("/console/scheduled");
    expect(screen.getByRole("tab", { name: S.tabs.schedules })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await userEvent.click(screen.getByRole("button", { name: "history back" }));
    await waitFor(() => {
      expectLocation("/console/workflow");
      expect(screen.getByRole("tab", { name: S.tabs.rules })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });

    await userEvent.click(screen.getByRole("button", { name: "history forward" }));
    await waitFor(() => {
      expectLocation("/console/scheduled");
      expect(screen.getByRole("tab", { name: S.tabs.schedules })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
  });

  it("gives the monitor tab a reloadable workflow sub-route", async () => {
    installHandlers([]);
    const initialView = renderBody();

    await screen.findByRole("tab", { name: S.tabs.rules, selected: true });
    await userEvent.click(screen.getByRole("tab", { name: S.tabs.monitors }));

    expectLocation("/console/workflow?tab=monitors");
    expect(screen.getByRole("tab", { name: S.tabs.monitors })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    initialView.unmount();
    renderBody(["SUPER_ADMIN"], ["/console/workflow?tab=monitors"]);
    expect(
      await screen.findByRole("tab", { name: S.tabs.monitors, selected: true }),
    ).toBeVisible();
  });

  it.each([
    [
      "/console/scheduled?keep=1&tab=monitors#anchor",
      "/console/scheduled?keep=1#anchor",
      S.tabs.schedules,
    ],
    [
      "/console/workflow?tab=unsupported&keep=1#anchor",
      "/console/workflow?keep=1#anchor",
      S.tabs.rules,
    ],
  ] as const)("replace-canonicalizes stale tab state in %s", async (input, expected, selectedTab) => {
    installHandlers([]);
    renderBody(["SUPER_ADMIN"], ["/sentinel", input]);

    expect(await screen.findByRole("tab", { name: selectedTab, selected: true })).toBeVisible();
    await waitFor(() => {
      expectLocation(expected);
    });

    await userEvent.click(screen.getByRole("button", { name: "history back" }));
    await waitFor(() => {
      expectLocation("/sentinel");
    });
  });

  it("preserves unrelated query and hash while switching tabs", async () => {
    installHandlers([]);
    renderBody(["SUPER_ADMIN"], ["/console/workflow?keep=1#anchor"]);

    await screen.findByRole("tab", { name: S.tabs.rules, selected: true });
    await userEvent.click(screen.getByRole("tab", { name: S.tabs.monitors }));
    expectLocation("/console/workflow?keep=1&tab=monitors#anchor");

    await userEvent.click(screen.getByRole("tab", { name: S.tabs.schedules }));
    expectLocation("/console/scheduled?keep=1#anchor");
  });

  it("tracks monitor history with exact back and forward locations", async () => {
    installHandlers([]);
    renderBody();

    await screen.findByRole("tab", { name: S.tabs.rules, selected: true });
    await userEvent.click(screen.getByRole("tab", { name: S.tabs.monitors }));
    expectLocation("/console/workflow?tab=monitors");

    await userEvent.click(screen.getByRole("button", { name: "history back" }));
    await waitFor(() => {
      expectLocation("/console/workflow");
      expect(screen.getByRole("tab", { name: S.tabs.rules })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });

    await userEvent.click(screen.getByRole("button", { name: "history forward" }));
    await waitFor(() => {
      expectLocation("/console/workflow?tab=monitors");
      expect(screen.getByRole("tab", { name: S.tabs.monitors })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
  });

  it.each([
    ["/console/workflow", S.tabs.rules],
    ["/console/workflow?keep=1&tab=monitors#anchor", S.tabs.monitors],
    ["/console/scheduled?keep=1#anchor", S.tabs.schedules],
  ] as const)("does not add a history entry when the current tab at %s is selected", async (path, tabLabel) => {
    installHandlers([]);
    renderBody(["SUPER_ADMIN"], ["/sentinel", path]);

    const currentTab = await screen.findByRole("tab", { name: tabLabel, selected: true });
    await userEvent.click(currentTab);
    expectLocation(path);

    await userEvent.click(screen.getByRole("button", { name: "history back" }));
    await waitFor(() => {
      expectLocation("/sentinel");
    });
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
