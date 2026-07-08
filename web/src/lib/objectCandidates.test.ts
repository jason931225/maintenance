import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { components } from "@maintenance/api-client-ts";
import { createConsoleApiClient } from "../api/client";
import { userPage, workOrderListItems } from "../test/fixtures";
import { createPersonCandidateProvider, createWorkOrderCandidateProvider } from "./objectCandidates";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

function user(overrides: Partial<components["schemas"]["UserSummary"]>): components["schemas"]["UserSummary"] {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    display_name: "제갈태수",
    employee_id: null,
    employee_name: null,
    employee_number: null,
    employee_company: null,
    employee_org_unit: null,
    employee_position: null,
    employee_identity_review_required: null,
    employee_identity_resolution_confidence: null,
    employee_link_status: "UNLINKED",
    phone: null,
    team: "MAINTENANCE",
    roles: ["MECHANIC"],
    branch_ids: [],
    is_active: true,
    has_passkey: true,
    account_status: "ACTIVE",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("createPersonCandidateProvider", () => {
  it("filters by display name and maps to ObjectCandidate", async () => {
    server.use(
      http.get("*/api/v1/users", () =>
        HttpResponse.json(
          userPage([
            user({ id: "u1", display_name: "제갈태수" }),
            user({ id: "u2", display_name: "홍길동" }),
          ]),
        ),
      ),
    );
    const api = createConsoleApiClient("test-token");
    const provide = createPersonCandidateProvider(api);

    const results = await provide("길동");
    expect(results).toEqual([{ kind: "person", code: "u2", label: "홍길동" }]);
  });

  it("returns candidates only from what the (branch-scoped) endpoint returned — never adds its own filtering by permission", async () => {
    server.use(
      http.get("*/api/v1/users", () =>
        HttpResponse.json(userPage([user({ id: "u1", display_name: "제갈태수" })])),
      ),
    );
    const api = createConsoleApiClient("test-token");
    const provide = createPersonCandidateProvider(api);

    const results = await provide("");
    expect(results).toEqual([{ kind: "person", code: "u1", label: "제갈태수" }]);
  });

  it("excludes inactive users", async () => {
    server.use(
      http.get("*/api/v1/users", () =>
        HttpResponse.json(userPage([user({ id: "u1", display_name: "퇴사자", is_active: false })])),
      ),
    );
    const api = createConsoleApiClient("test-token");
    const provide = createPersonCandidateProvider(api);

    expect(await provide("")).toEqual([]);
  });
});

describe("createWorkOrderCandidateProvider", () => {
  it("filters by request_no/customer/site/equipment and formats the WO- code", async () => {
    server.use(
      http.get("*/api/v1/work-orders", () =>
        HttpResponse.json({ items: workOrderListItems, limit: 50, offset: 0, total: workOrderListItems.length }),
      ),
    );
    const api = createConsoleApiClient("test-token");
    const provide = createWorkOrderCandidateProvider(api);

    const byCustomer = await provide("케이앤엘");
    expect(byCustomer).toHaveLength(1);
    expect(byCustomer[0]).toMatchObject({ kind: "workOrder", code: "WO-20260612-001" });

    const byRequestNo = await provide("20260612-002");
    expect(byRequestNo).toHaveLength(1);
    expect(byRequestNo[0].code).toBe("WO-20260612-002");
  });

  it("returns nothing for a query that matches no work order", async () => {
    server.use(
      http.get("*/api/v1/work-orders", () =>
        HttpResponse.json({ items: workOrderListItems, limit: 50, offset: 0, total: workOrderListItems.length }),
      ),
    );
    const api = createConsoleApiClient("test-token");
    const provide = createWorkOrderCandidateProvider(api);

    expect(await provide("존재하지않음")).toEqual([]);
  });
});
