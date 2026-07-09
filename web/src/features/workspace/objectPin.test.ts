import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createConsoleApiClient } from "../../api/client";
import { ko } from "../../i18n/ko";
import { workOrderListItems } from "../../test/fixtures";
import { fetchPinnedObject } from "./objectPin";

const server = setupServer();
const branchId = "11111111-1111-4111-8111-111111111111";
const personId = "22222222-2222-4222-8222-222222222222";

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

describe("fetchPinnedObject — person (AC4)", () => {
  it("reads the branch member endpoint (which records the person.view audit) and builds a pin", async () => {
    let requestedPath = "";
    let requestedBranch: string | null = null;
    server.use(
      http.get("*/api/messenger/members/:userId", ({ request, params }) => {
        requestedPath = String(params.userId);
        requestedBranch = new URL(request.url).searchParams.get("branch_id");
        return HttpResponse.json({ id: personId, display_name: "홍길동", team: "MAINTENANCE" });
      }),
    );
    const api = createConsoleApiClient("test-token");

    const pin = await fetchPinnedObject(api, "person", { id: personId, code: personId, branchId });

    // The audit-recording server call was made for this person + branch.
    expect(requestedPath).toBe(personId);
    expect(requestedBranch).toBe(branchId);
    expect(pin).toMatchObject({ kind: "person", code: personId, title: "홍길동" });
  });

  it("returns null (no pin) when the person is not a visible branch member", async () => {
    server.use(
      http.get("*/api/messenger/members/:userId", () =>
        HttpResponse.json({ error: "not found" }, { status: 404 }),
      ),
    );
    const api = createConsoleApiClient("test-token");

    expect(await fetchPinnedObject(api, "person", { id: personId, code: personId, branchId })).toBeNull();
  });

  it("does not call the API and returns null when no branch is scoped", async () => {
    let called = false;
    server.use(
      http.get("*/api/messenger/members/:userId", () => {
        called = true;
        return HttpResponse.json({ id: personId, display_name: "홍길동" });
      }),
    );
    const api = createConsoleApiClient("test-token");

    expect(await fetchPinnedObject(api, "person", { id: personId, code: personId, branchId: undefined })).toBeNull();
    expect(called).toBe(false);
  });
});

describe("fetchPinnedObject — work order (#21)", () => {
  it("fetches the branch-scoped detail and builds a status/priority pin", async () => {
    const wo = workOrderListItems[0];
    server.use(http.get("*/api/v1/work-orders/:id", () => HttpResponse.json(wo)));
    const api = createConsoleApiClient("test-token");

    const pin = await fetchPinnedObject(api, "workOrder", {
      id: wo.id,
      code: `WO-${wo.request_no}`,
      branchId,
    });

    expect(pin).toMatchObject({ kind: "workOrder", code: `WO-${wo.request_no}` });
    expect(pin?.fields.map((f) => f.label)).toEqual([
      ko.console.workspace.field.status,
      ko.console.workspace.field.priority,
    ]);
    // Status/priority rendered as Korean labels, never raw enum codes.
    expect(pin?.fields[0].value).toBe(ko.status[wo.status]);
  });

  it("returns null (no pin) when the work order is not found", async () => {
    server.use(
      http.get("*/api/v1/work-orders/:id", () => HttpResponse.json({ error: "nf" }, { status: 404 })),
    );
    const api = createConsoleApiClient("test-token");

    expect(
      await fetchPinnedObject(api, "workOrder", { id: "x", code: "WO-x", branchId }),
    ).toBeNull();
  });
});

describe("fetchPinnedObject — support ticket (#21)", () => {
  it("fetches the ticket detail and builds a title + Korean status pin", async () => {
    const ticketId = "33333333-3333-4333-8333-333333333333";
    server.use(
      http.get("*/api/v1/support/tickets/:id", () =>
        HttpResponse.json({ ticket: { id: ticketId, title: "출고 지연 문의", status: "OPEN" }, comments: [] }),
      ),
    );
    const api = createConsoleApiClient("test-token");

    const pin = await fetchPinnedObject(api, "support", { id: ticketId, code: `CS-${ticketId}`, branchId });

    expect(pin).toMatchObject({ kind: "support", code: `CS-${ticketId}`, title: "출고 지연 문의" });
    expect(pin?.fields[0].value).toBe(ko.support.ticketStatus.OPEN);
  });

  it("returns null (no pin) when the ticket is not found", async () => {
    server.use(
      http.get("*/api/v1/support/tickets/:id", () => HttpResponse.json({ error: "nf" }, { status: 404 })),
    );
    const api = createConsoleApiClient("test-token");

    expect(await fetchPinnedObject(api, "support", { id: "x", code: "CS-x", branchId })).toBeNull();
  });
});
