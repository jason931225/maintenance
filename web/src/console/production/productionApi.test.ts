import { afterEach, describe, expect, it, vi } from "vitest";
import { productionApi } from "./productionApi";

describe("productionApi", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the tenant production API for branch-scoped pagination", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await productionApi.list("4a3879b8-c42c-4d59-a53f-35e35ccf9477", 25);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/production/plans?branch_id=4a3879b8-c42c-4d59-a53f-35e35ccf9477&limit=25&offset=25",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("surfaces server failures instead of synthesizing a successful record", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "denied" } }), { status: 403, headers: { "content-type": "application/json" } })));

    await expect(productionApi.get("fbc58f5b-b1f4-481d-a661-4c09f6e49907")).rejects.toThrow("denied");
  });
});
