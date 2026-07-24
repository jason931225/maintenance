import { createConsoleApiClient } from "../../api/client";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { listPurchaseRequestQueue } from "./purchaseRequestQueue";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

describe("listPurchaseRequestQueue", () => {
  it("uses repeated plain status query keys", async () => {
    let query: URLSearchParams | undefined;
    server.use(
      http.get("*/api/v1/financial/purchase-requests", ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json({ items: [], limit: 25, offset: 0, total: 0 });
      }),
    );

    const response = await listPurchaseRequestQueue(
      createConsoleApiClient("test-token"),
      {
        branchId: "00000000-0000-0000-0000-000000000001",
        statuses: ["REQUEST_SUBMITTED", "ADMIN_APPROVED"],
        limit: 25,
        offset: 0,
      },
    );

    expect(response.error).toBeUndefined();
    expect(query?.get("branch_id")).toBe("00000000-0000-0000-0000-000000000001");
    expect(query?.getAll("status")).toEqual([
      "REQUEST_SUBMITTED",
      "ADMIN_APPROVED",
    ]);
    expect(query?.has("status[]")).toBe(false);
  });
});
