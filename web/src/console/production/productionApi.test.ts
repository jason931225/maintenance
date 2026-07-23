import { afterEach, describe, expect, it, vi } from "vitest";

import { productionApi } from "./productionApi";

describe("productionApi", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the DailyPlan API and forwards backend request bodies", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));
    vi.stubGlobal("fetch", fetchMock);

    await productionApi.list("2026-07-23");
    await productionApi.review("plan/a", { decision: "APPROVED", memo: "확인" });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/daily-work-plans?plan_date=2026-07-23",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/daily-work-plans/plan%2Fa/review",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ decision: "APPROVED", memo: "확인" }) }),
    );
  });

  it("surfaces a backend denial instead of synthesizing success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "denied" } }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    ));

    await expect(productionApi.confirm("plan-1")).rejects.toThrow("denied");
  });
});
