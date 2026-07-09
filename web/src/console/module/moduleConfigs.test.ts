import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { ko } from "../../i18n/ko";
import { demoTickets, demoWorkOrders } from "../../test/module-fixtures";
import { supportTicketModuleConfig, workOrderModuleConfig, type Ticket } from "./moduleConfigs";

/**
 * Proves the two configs bind their REAL endpoints end to end at the data
 * layer: `load` maps a schema-shaped response into rows, and each row action
 * fires the correct mutation with the correct path + body. The live harness
 * exercises the same code against the real backend at runtime.
 */

interface ApiResult {
  data?: unknown;
  error?: unknown;
  response: { ok: boolean };
}

function makeApi(handlers: {
  get?: (path: string, opts?: unknown) => ApiResult;
  post?: (path: string, opts?: unknown) => ApiResult;
}) {
  const GET = vi.fn((path: string, opts?: unknown) => Promise.resolve(handlers.get?.(path, opts) ?? { data: { items: [] }, response: { ok: true } }));
  const POST = vi.fn((path: string, opts?: unknown) => Promise.resolve(handlers.post?.(path, opts) ?? { data: {}, response: { ok: true } }));
  const api = { GET, POST } as unknown as ConsoleApiClient;
  return { api, GET, POST };
}

describe("workOrderModuleConfig — live binding", () => {
  it("loads work orders from /api/v1/work-orders", async () => {
    const { api, GET } = makeApi({ get: () => ({ data: { items: demoWorkOrders }, response: { ok: true } }) });
    const rows = await workOrderModuleConfig.load(api);
    expect(GET).toHaveBeenCalledWith("/api/v1/work-orders", { params: { query: { limit: 100 } } });
    expect(rows).toHaveLength(demoWorkOrders.length);
  });

  it("throws when the read fails (never a silent empty list)", async () => {
    const { api } = makeApi({ get: () => ({ error: { code: "x" }, response: { ok: false } }) });
    await expect(workOrderModuleConfig.load(api)).rejects.toThrow();
  });

  it("reject action POSTs to the reject endpoint with an audit memo", async () => {
    const row = demoWorkOrders[0];
    const { api, POST } = makeApi({ post: () => ({ data: {}, response: { ok: true } }) });
    const action = workOrderModuleConfig.detail.actions(row)[0];
    expect(action.policy).toBe("work_order.reject");
    await action.run(row, api);
    expect(POST).toHaveBeenCalledWith(
      "/api/v1/work-orders/{workOrderId}/reject",
      expect.objectContaining({ params: { path: { workOrderId: row.id } } }),
    );
    const [, opts] = POST.mock.calls[0];
    expect((opts as { body: { memo: string } }).body.memo.length).toBeGreaterThan(0);
  });
});

describe("supportTicketModuleConfig — live binding", () => {
  it("loads tickets from /api/v1/support/tickets", async () => {
    const { api, GET } = makeApi({ get: () => ({ data: { items: demoTickets }, response: { ok: true } }) });
    const rows = await supportTicketModuleConfig.load(api);
    expect(GET).toHaveBeenCalledWith("/api/v1/support/tickets", { params: { query: { limit: 100 } } });
    expect(rows).toHaveLength(demoTickets.length);
  });

  it("throws when the ticket read fails (never a silent empty list)", async () => {
    const { api } = makeApi({ get: () => ({ error: { code: "x" }, response: { ok: false } }) });
    await expect(supportTicketModuleConfig.load(api)).rejects.toThrow();
  });

  it("resolve action transitions the ticket to RESOLVED", async () => {
    const row = demoTickets[0];
    const { api, POST } = makeApi({ post: () => ({ data: {}, response: { ok: true } }) });
    const action = supportTicketModuleConfig.detail.actions(row)[0];
    expect(action.policy).toBe("support.transition");
    await action.run(row, api);
    expect(POST).toHaveBeenCalledWith(
      "/api/v1/support/tickets/{id}/transition",
      expect.objectContaining({ params: { path: { id: row.id } }, body: { to_status: "RESOLVED" } }),
    );
  });

  it("support has no link chips (UUID-keyed, no issued code)", () => {
    expect(supportTicketModuleConfig.detail.links(demoTickets[0])).toEqual([]);
  });

  it("search is null-safe for missing ticket fields and enum lookups", () => {
    const row = {
      ...demoTickets[0],
      title: null,
      requester_name: null,
      category: "UNKNOWN",
      status: "UNKNOWN",
    } as unknown as Ticket;
    expect(() => supportTicketModuleConfig.search(row)).not.toThrow();
    expect(supportTicketModuleConfig.search(row)).not.toContain("undefined");
  });
});

describe("module enum labels", () => {
  it("reuses the canonical work-order and support enum translations", () => {
    expect(ko.console.module.workOrder.status).toBe(ko.status);
    expect(ko.console.module.workOrder.priority).toBe(ko.priority);
    expect(ko.console.module.support.status).toBe(ko.support.ticketStatus);
    expect(ko.console.module.support.priority).toBe(ko.support.ticketPriority);
    expect(ko.console.module.support.category).toBe(ko.support.ticketCategory);
    expect(ko.console.module.support.origin).toBe(ko.support.ticketOrigin);
  });
});

describe("list cells — DESIGN §4.7-1 예외만 칩 (chips for exceptions only)", () => {
  const statusCol = supportTicketModuleConfig.columns.find((c) => c.key === "status");
  const mk = (status: Ticket["status"]) => ({ ...demoTickets[0], status });

  it("gives an exception status (OPEN→warn) a chip tone", () => {
    expect(statusCol?.cell(mk("OPEN")).tone).toBe("warn");
  });

  it("renders a routine status (CLOSED→neutral, RESOLVED→ok, IN_PROGRESS→accent) as plain text", () => {
    expect(statusCol?.cell(mk("CLOSED")).tone).toBeUndefined();
    expect(statusCol?.cell(mk("RESOLVED")).tone).toBeUndefined();
    expect(statusCol?.cell(mk("IN_PROGRESS")).tone).toBeUndefined();
  });
});
