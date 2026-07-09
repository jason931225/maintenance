import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { components } from "@maintenance/api-client-ts";
import { createConsoleApiClient } from "../api/client";
import { workOrderListItems } from "../test/fixtures";
import { createPersonCandidateProvider, createWorkOrderCandidateProvider } from "./objectCandidates";

const server = setupServer();
const branchId = "11111111-1111-4111-8111-111111111111";

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

function member(
  overrides: Partial<components["schemas"]["MessengerMemberSummary"]>,
): components["schemas"]["MessengerMemberSummary"] {
  return { id: "u1", display_name: "제갈태수", team: "MAINTENANCE", ...overrides };
}

describe("createPersonCandidateProvider", () => {
  it("uses the branch-scoped /api/messenger/members endpoint, not the admin-only /api/v1/users", async () => {
    let requestedPath = "";
    server.use(
      http.get("*/api/messenger/members", ({ request }) => {
        requestedPath = new URL(request.url).pathname;
        return HttpResponse.json({ items: [member({ id: "u2", display_name: "홍길동" })] });
      }),
    );
    const api = createConsoleApiClient("test-token");
    const provide = createPersonCandidateProvider(api, branchId);

    const result = await provide("길동");
    expect(requestedPath).toBe("/api/messenger/members");
    expect(result).toEqual({
      status: "ok",
      candidates: [{ kind: "person", code: "u2", label: "홍길동" }],
    });
  });

  it("filters by display name and returns nothing for a query that matches no member", async () => {
    server.use(
      http.get("*/api/messenger/members", () =>
        HttpResponse.json({ items: [member({ id: "u1", display_name: "제갈태수" })] }),
      ),
    );
    const api = createConsoleApiClient("test-token");
    const provide = createPersonCandidateProvider(api, branchId);

    expect(await provide("존재하지않음")).toEqual({ status: "ok", candidates: [] });
  });

  it("returns an explicit error state on a 403, never a silently-empty result", async () => {
    server.use(
      http.get("*/api/messenger/members", () => HttpResponse.json({ error: "forbidden" }, { status: 403 })),
    );
    const api = createConsoleApiClient("test-token");
    const provide = createPersonCandidateProvider(api, branchId);

    expect(await provide("")).toEqual({ status: "error" });
  });

  it("returns an explicit error state on a network failure", async () => {
    server.use(http.get("*/api/messenger/members", () => HttpResponse.error()));
    const api = createConsoleApiClient("test-token");
    const provide = createPersonCandidateProvider(api, branchId);

    expect(await provide("")).toEqual({ status: "error" });
  });
});

describe("createWorkOrderCandidateProvider", () => {
  it("filters by request_no/customer/site/equipment and formats the WO- code", async () => {
    server.use(
      http.get("*/api/v1/work-orders", () =>
        HttpResponse.json({ items: workOrderListItems, limit: 100, offset: 0, total: workOrderListItems.length }),
      ),
    );
    const api = createConsoleApiClient("test-token");
    const provide = createWorkOrderCandidateProvider(api);

    const byCustomer = await provide("케이앤엘");
    expect(byCustomer.status).toBe("ok");
    expect(byCustomer.status === "ok" && byCustomer.candidates).toMatchObject([
      { kind: "workOrder", code: "WO-20260612-001" },
    ]);

    const byRequestNo = await provide("20260612-002");
    expect(byRequestNo.status === "ok" && byRequestNo.candidates[0]?.code).toBe("WO-20260612-002");

    const byEquipmentNo = await provide("D-30-305");
    expect(byEquipmentNo.status === "ok" && byEquipmentNo.candidates[0]?.code).toBe("WO-20260612-002");
  });

  it("returns nothing for a query that matches no work order", async () => {
    server.use(
      http.get("*/api/v1/work-orders", () =>
        HttpResponse.json({ items: workOrderListItems, limit: 100, offset: 0, total: workOrderListItems.length }),
      ),
    );
    const api = createConsoleApiClient("test-token");
    const provide = createWorkOrderCandidateProvider(api);

    expect(await provide("존재하지않음")).toEqual({ status: "ok", candidates: [] });
  });

  it("returns an explicit error state on a 403, never a silently-empty result", async () => {
    server.use(
      http.get("*/api/v1/work-orders", () => HttpResponse.json({ error: "forbidden" }, { status: 403 })),
    );
    const api = createConsoleApiClient("test-token");
    const provide = createWorkOrderCandidateProvider(api);

    expect(await provide("")).toEqual({ status: "error" });
  });

  it("returns an explicit error state on a network failure", async () => {
    server.use(http.get("*/api/v1/work-orders", () => HttpResponse.error()));
    const api = createConsoleApiClient("test-token");
    const provide = createWorkOrderCandidateProvider(api);

    expect(await provide("")).toEqual({ status: "error" });
  });
});
