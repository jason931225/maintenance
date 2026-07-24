import { createConsoleApiClient, type ConsoleApiClient } from "../../api/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProductionApi } from "./productionApi";

describe("createProductionApi", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the authenticated console client bearer and typed DailyPlan endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await createProductionApi(createConsoleApiClient("bearer-token")).list("2026-07-23");
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.url).toContain("/api/daily-work-plans?plan_date=2026-07-23");
    expect(request.headers.get("Authorization")).toBe("Bearer bearer-token");
    expect(request.headers.get("X-Auth-Transport")).toBe("cookie");
  });

  it("forwards endpoint params and bodies through the client instead of a module fetch", async () => {
    const api = { GET: vi.fn(), POST: vi.fn().mockResolvedValue({ data: { id: "plan-1" }, response: new Response(null, { status: 200 }) }) } as unknown as ConsoleApiClient;
    await createProductionApi(api).review("plan/a", { decision: "APPROVED", memo: "확인" });
    expect(api.POST).toHaveBeenCalledWith("/api/daily-work-plans/{planId}/review", expect.objectContaining({
      params: { path: { planId: "plan/a" } }, body: { decision: "APPROVED", memo: "확인" },
    }));
  });

  it("surfaces a backend denial instead of synthesizing success", async () => {
    const api = { GET: vi.fn(), POST: vi.fn().mockResolvedValue({ error: { error: { message: "denied" } }, response: new Response(null, { status: 403 }) }) } as unknown as ConsoleApiClient;
    await expect(createProductionApi(api).confirm("plan-1")).rejects.toThrow("denied");
  });
});
