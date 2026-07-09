import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { components } from "@maintenance/api-client-ts";
import { createConsoleApiClient } from "../api/client";
import { workOrderListItems } from "../test/fixtures";
import {
  createPersonCandidateProvider,
  createWorkOrderCandidateProvider,
  filterCandidates,
  type ObjectCandidate,
} from "./objectCandidates";

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
  it("fetches one page from the branch-scoped /api/messenger/members endpoint, not the admin-only /api/v1/users", async () => {
    let requestedPath = "";
    server.use(
      http.get("*/api/messenger/members", ({ request }) => {
        requestedPath = new URL(request.url).pathname;
        return HttpResponse.json({ items: [member({ id: "u2", display_name: "홍길동" })] });
      }),
    );
    const api = createConsoleApiClient("test-token");
    const provide = createPersonCandidateProvider(api, branchId);

    const result = await provide();
    expect(requestedPath).toBe("/api/messenger/members");
    expect(result).toEqual({
      status: "ok",
      candidates: [{ kind: "person", code: "u2", label: "홍길동", search: "홍길동" }],
    });
  });

  it("returns an explicit error state on a 403, never a silently-empty result", async () => {
    server.use(
      http.get("*/api/messenger/members", () => HttpResponse.json({ error: "forbidden" }, { status: 403 })),
    );
    const api = createConsoleApiClient("test-token");
    const provide = createPersonCandidateProvider(api, branchId);

    expect(await provide()).toEqual({ status: "error" });
  });

  it("returns an explicit error state on a network failure", async () => {
    server.use(http.get("*/api/messenger/members", () => HttpResponse.error()));
    const api = createConsoleApiClient("test-token");
    const provide = createPersonCandidateProvider(api, branchId);

    expect(await provide()).toEqual({ status: "error" });
  });

  it("fetches the page once, then re-filters the cached rows locally per query (no refetch)", async () => {
    let requests = 0;
    server.use(
      http.get("*/api/messenger/members", () => {
        requests += 1;
        return HttpResponse.json({
          items: [member({ id: "u1", display_name: "제갈태수" }), member({ id: "u2", display_name: "홍길동" })],
        });
      }),
    );
    const api = createConsoleApiClient("test-token");
    const provide = createPersonCandidateProvider(api, branchId);

    const page = await provide();
    expect(page.status).toBe("ok");
    if (page.status !== "ok") return;
    expect(requests).toBe(1);

    // Filtering narrows as the query grows, all without another fetch.
    expect(filterCandidates(page.candidates, "").map((c) => c.code)).toEqual(["u1", "u2"]);
    expect(filterCandidates(page.candidates, "홍길동").map((c) => c.code)).toEqual(["u2"]);
    expect(filterCandidates(page.candidates, "존재하지않음")).toEqual([]);
    expect(requests).toBe(1);
  });
});

describe("createWorkOrderCandidateProvider", () => {
  it("fetches one page and re-filters by request_no/customer/site/equipment locally", async () => {
    let requests = 0;
    server.use(
      http.get("*/api/v1/work-orders", () => {
        requests += 1;
        return HttpResponse.json({ items: workOrderListItems, limit: 100, offset: 0, total: workOrderListItems.length });
      }),
    );
    const api = createConsoleApiClient("test-token");
    const provide = createWorkOrderCandidateProvider(api);

    const page = await provide();
    expect(page.status).toBe("ok");
    if (page.status !== "ok") return;
    expect(requests).toBe(1);

    expect(filterCandidates(page.candidates, "케이앤엘").map((c) => c.code)).toEqual(["WO-20260612-001"]);
    expect(filterCandidates(page.candidates, "20260612-002")[0]?.code).toBe("WO-20260612-002");
    expect(filterCandidates(page.candidates, "D-30-305")[0]?.code).toBe("WO-20260612-002");
    expect(filterCandidates(page.candidates, "존재하지않음")).toEqual([]);
    expect(requests).toBe(1);
  });

  it("returns an explicit error state on a 403, never a silently-empty result", async () => {
    server.use(
      http.get("*/api/v1/work-orders", () => HttpResponse.json({ error: "forbidden" }, { status: 403 })),
    );
    const api = createConsoleApiClient("test-token");
    const provide = createWorkOrderCandidateProvider(api);

    expect(await provide()).toEqual({ status: "error" });
  });

  it("returns an explicit error state on a network failure", async () => {
    server.use(http.get("*/api/v1/work-orders", () => HttpResponse.error()));
    const api = createConsoleApiClient("test-token");
    const provide = createWorkOrderCandidateProvider(api);

    expect(await provide()).toEqual({ status: "error" });
  });
});

describe("filterCandidates", () => {
  const candidates: ObjectCandidate[] = Array.from({ length: 12 }, (_, i) => ({
    kind: "person" as const,
    code: `u${String(i)}`,
    label: `user ${String(i)}`,
    search: `user ${String(i)}`,
  }));

  it("caps the visible slice at the candidate limit (8)", () => {
    expect(filterCandidates(candidates, "")).toHaveLength(8);
  });

  it("matches case-insensitively against the search haystack", () => {
    expect(filterCandidates(candidates, "USER 11").map((c) => c.code)).toEqual(["u11"]);
  });
});
