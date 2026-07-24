import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import type { AuthSession } from "../../context/auth";
import { productionStrings as text } from "../../i18n/production";
import { AuthTestProvider } from "../../test/AuthTestProvider";
import type { DailyPlan } from "./productionApi";
import { ProductionConsoleRoute } from "./ProductionConsoleRoute";

const authz = vi.hoisted(() => ({ featureGrants: [] as string[] }));

vi.mock("../shell/authz", () => ({
  useConsoleAuthz: () => ({ grants: { roles: [], featureGrants: authz.featureGrants }, source: "authz" }),
}));

const session = (incarnation = "session-a"): AuthSession => ({
  access_token: "token", user_id: "mechanic-1", org_id: "org-1", client_session_incarnation: incarnation,
});
const plan = (branchId = "branch-1", status: DailyPlan["status"] = "DRAFT"): DailyPlan => ({
  id: "plan-1", branch_id: branchId, mechanic_id: "mechanic-1", plan_date: "2026-07-23", status,
  items: [{ sort_order: 1, description: "현장 점검", work_order_id: "work-1" }],
});
const ok = <T,>(data: T) => ({ data, response: new Response(null, { status: 200 }) });
const client = () => ({ GET: vi.fn(), POST: vi.fn() } as unknown as ConsoleApiClient);

function mounted(api: ConsoleApiClient, currentSession = session(), branchId = "branch-1") {
  return <AuthTestProvider session={currentSession} overrides={{ api }}><ProductionConsoleRoute branchId={branchId} /></AuthTestProvider>;
}

describe("ProductionConsoleRoute", () => {
  it("mounts from canonical authz grants: allow exposes actions and request-only denies", async () => {
    const api = client();
    vi.mocked(api.GET).mockResolvedValue(ok({ items: [plan()] }));
    authz.featureGrants = ["daily_plan_request"];
    const view = render(mounted(api));
    expect(await screen.findByRole("button", { name: text.create })).toBeVisible();
    expect(api.GET).toHaveBeenCalledWith("/api/daily-work-plans", expect.anything());

    authz.featureGrants = [];
    view.rerender(mounted(api));
    expect(await screen.findByText(text.denied)).toBeVisible();
    expect(screen.queryByRole("button", { name: text.create })).toBeNull();
  });

  it("fences session, branch, and API switches before stale outgoing work can update the mounted body", async () => {
    authz.featureGrants = ["daily_plan_request"];
    const first = { promise: undefined as Promise<ReturnType<typeof ok<{ items: DailyPlan[] }>>> | undefined, resolve: undefined as ((value: ReturnType<typeof ok<{ items: DailyPlan[] }>>) => void) | undefined };
    first.promise = new Promise((resolve) => { first.resolve = resolve; });
    const apiA = client();
    const apiB = client();
    vi.mocked(apiA.GET).mockReturnValue(first.promise as never);
    vi.mocked(apiB.GET).mockResolvedValue(ok({ items: [plan("branch-2", "REQUESTED")] }));
    const view = render(mounted(apiA));
    await waitFor(() => expect(apiA.GET).toHaveBeenCalledTimes(1));
    const oldSignal = vi.mocked(apiA.GET).mock.calls[0]?.[1]?.signal;

    view.rerender(mounted(apiB, session("session-b"), "branch-2"));
    expect(await screen.findByRole("button", { name: /2026-07-23/ })).toHaveTextContent(text.status.REQUESTED);
    expect(oldSignal?.aborted).toBe(true);
    first.resolve?.(ok({ items: [plan()] }));
    await waitFor(() => expect(screen.getByRole("button", { name: /2026-07-23/ })).toHaveTextContent(text.status.REQUESTED));
    expect(apiB.GET).toHaveBeenCalledWith("/api/daily-work-plans", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
});
