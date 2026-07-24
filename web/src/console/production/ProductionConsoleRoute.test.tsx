import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import type { AuthSession } from "../../context/auth";
import { productionStrings as text } from "../../i18n/production";
import { AuthTestProvider } from "../../test/AuthTestProvider";
import type { DailyPlan } from "./productionApi";
import { ProductionConsoleRoute } from "./ProductionConsoleRoute";

const session = (incarnation = "session-a"): AuthSession => ({
  access_token: "token", user_id: "mechanic-1", org_id: "org-1", client_session_incarnation: incarnation,
});
const plan = (branchId = "branch-a", status: DailyPlan["status"] = "DRAFT"): DailyPlan => ({
  id: "plan-1", branch_id: branchId, mechanic_id: "mechanic-1", plan_date: "2026-07-23", status,
  items: [{ sort_order: 1, description: "현장 점검", work_order_id: "work-1" }],
});
const ok = <T,>(data: T) => ({ data, response: new Response(null, { status: 200 }) });
const client = () => ({ GET: vi.fn(), POST: vi.fn() } as unknown as ConsoleApiClient);

function mounted(api: ConsoleApiClient, currentSession = session(), branchId = "branch-a") {
  return <AuthTestProvider session={currentSession} overrides={{ api }}><ProductionConsoleRoute branchId={branchId} /></AuthTestProvider>;
}

function authzResponse(capabilities: unknown[]) {
  return new Response(JSON.stringify({
    roles: ["MECHANIC"],
    branch_scope: { kind: "branches", branches: ["branch-a"] },
    capabilities,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("ProductionConsoleRoute", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("mounts from the parsed MeAuthzResponse capability: allow branch A, deny branch B", async () => {
    const api = client();
    vi.mocked(api.GET).mockResolvedValue(ok({ items: [plan()] }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(authzResponse([
      { feature: "daily_plan_request", permission: "allow", branch_scope: { kind: "branches", branches: ["branch-a"] } },
    ])));
    const view = render(mounted(api));
    expect(await screen.findByRole("button", { name: text.create })).toBeVisible();
    await waitFor(() => expect(api.GET).toHaveBeenCalledWith("/api/daily-work-plans", expect.anything()));

    view.rerender(mounted(api, session(), "branch-b"));
    expect(await screen.findByText(text.denied)).toBeVisible();
    expect(screen.queryByRole("button", { name: text.create })).toBeNull();
  });

  it("denies request_only capabilities from the parsed MeAuthzResponse", async () => {
    const api = client();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(authzResponse([
      { feature: "daily_plan_request", permission: "request_only", branch_scope: { kind: "all" } },
    ])));
    render(mounted(api));
    expect(await screen.findByText(text.denied)).toBeVisible();
    expect(api.GET).not.toHaveBeenCalled();
  });

  it("fences session and API switches before stale outgoing work can update the mounted body", async () => {
    const first = { promise: undefined as Promise<ReturnType<typeof ok<{ items: DailyPlan[] }>>> | undefined, resolve: undefined as ((value: ReturnType<typeof ok<{ items: DailyPlan[] }>>) => void) | undefined };
    first.promise = new Promise((resolve) => { first.resolve = resolve; });
    const apiA = client();
    const apiB = client();
    vi.mocked(apiA.GET).mockReturnValue(first.promise as never);
    vi.mocked(apiB.GET).mockResolvedValue(ok({ items: [plan("branch-a", "REQUESTED")] }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(authzResponse([
      { feature: "daily_plan_request", permission: "allow", branch_scope: { kind: "all" } },
    ])));
    const view = render(mounted(apiA));
    await waitFor(() => expect(apiA.GET).toHaveBeenCalledTimes(1));
    const oldSignal = vi.mocked(apiA.GET).mock.calls[0]?.[1]?.signal;

    view.rerender(mounted(apiB, session("session-b")));
    expect(await screen.findByRole("button", { name: /2026-07-23/ })).toHaveTextContent(text.status.REQUESTED);
    expect(oldSignal?.aborted).toBe(true);
    first.resolve?.(ok({ items: [plan()] }));
    await waitFor(() => expect(screen.getByRole("button", { name: /2026-07-23/ })).toHaveTextContent(text.status.REQUESTED));
  });
});
