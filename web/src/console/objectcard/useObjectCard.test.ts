import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createConsoleApiClient } from "../../api/client";
import { useObjectCard } from "./useObjectCard";

const server = setupServer();
const TOKEN = "test-token";
const TARGET = { kind: "work_order", id: "wo-1" };

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

function headBody(exists: boolean) {
  return {
    kind: "work_order",
    id: "wo-1",
    code: exists ? "WO-20260612-001" : null,
    title: exists ? "지게차 정비" : null,
    status: exists ? "IN_PROGRESS" : null,
    exists,
  };
}

function edge(id: string, dstId: string) {
  return {
    id,
    src_kind: "work_order",
    src_id: "wo-1",
    dst_kind: "approval_run",
    dst_id: dstId,
    link_type: "relates_to",
    created_by: null,
    created_at: "2026-07-01T00:00:00Z",
  };
}

function renderCard() {
  const api = createConsoleApiClient(TOKEN);
  return renderHook(() => useObjectCard(api, TOKEN, TARGET));
}

describe("useObjectCard — 3-layer load", () => {
  it("resolves the head, lifecycle, audit timeline, and links", async () => {
    server.use(
      http.get("*/api/objects/work_order/wo-1", () => HttpResponse.json(headBody(true))),
      http.get("*/api/v1/lifecycles/work_order/wo-1", () =>
        HttpResponse.json({
          objectType: "work_order",
          objectId: "wo-1",
          currentState: "active",
          legalHold: false,
          createdAt: "2026-07-01T00:00:00Z",
          updatedAt: "2026-07-01T00:00:00Z",
          transitions: [],
        }),
      ),
      http.get("*/api/audit", ({ request }) => {
        expect(new URL(request.url).searchParams.get("target_id")).toBe("wo-1");
        return HttpResponse.json({
          items: [{ id: "a1", action: "work_order.update", actor: "u1", target_type: "work_order", occurred_at: "2026-07-02T09:00:00Z" }],
          limit: 20,
          offset: 0,
        });
      }),
      http.get("*/api/v1/object-links", () => HttpResponse.json({ outgoing: [edge("lnk-1", "AP-3121")], incoming: [] })),
    );

    const { result } = renderCard();
    await waitFor(() => { expect(result.current.state.status).toBe("resolved"); });
    expect(result.current.state.head?.code).toBe("WO-20260612-001");
    expect(result.current.state.lifecycle?.currentState).toBe("active");
    expect(result.current.state.audit?.[0]?.action).toBe("work_order.update");
    expect(result.current.state.links.outgoing).toHaveLength(1);
  });

  it("degrades each layer independently when its read is denied", async () => {
    server.use(
      http.get("*/api/objects/work_order/wo-1", () => HttpResponse.json(headBody(true))),
      http.get("*/api/v1/lifecycles/work_order/wo-1", () => new HttpResponse(null, { status: 403 })),
      http.get("*/api/audit", () => new HttpResponse(null, { status: 403 })),
      http.get("*/api/v1/object-links", () => HttpResponse.json({ outgoing: [], incoming: [] })),
    );
    const { result } = renderCard();
    await waitFor(() => { expect(result.current.state.status).toBe("resolved"); });
    expect(result.current.state.lifecycle).toBeNull();
    expect(result.current.state.audit).toBeNull();
  });
});

describe("useObjectCard — deny-by-omission", () => {
  it("reports absent (no card) when the object does not resolve", async () => {
    server.use(http.get("*/api/objects/work_order/wo-1", () => HttpResponse.json(headBody(false))));
    const { result } = renderCard();
    await waitFor(() => { expect(result.current.state.status).toBe("absent"); });
    expect(result.current.state.lifecycle).toBeNull();
    expect(result.current.state.audit).toBeNull();
  });
});

describe("useObjectCard — relation mutations", () => {
  const baseHandlers = (links: () => { outgoing: unknown[]; incoming: unknown[] }) => [
    http.get("*/api/objects/work_order/wo-1", () => HttpResponse.json(headBody(true))),
    http.get("*/api/v1/lifecycles/work_order/wo-1", () => new HttpResponse(null, { status: 403 })),
    http.get("*/api/audit", () => new HttpResponse(null, { status: 403 })),
    http.get("*/api/v1/object-links", () => HttpResponse.json(links())),
  ];

  it("adds a relation from a bare code via a real POST, then reloads links", async () => {
    let created: Record<string, unknown> | null = null;
    let links: { outgoing: unknown[]; incoming: unknown[] } = { outgoing: [], incoming: [] };
    server.use(
      ...baseHandlers(() => links),
      http.post("*/api/v1/object-links", async ({ request }) => {
        created = (await request.json()) as Record<string, unknown>;
        links = { outgoing: [edge("lnk-9", "WO-20260701-002")], incoming: [] };
        return HttpResponse.json(edge("lnk-9", "WO-20260701-002"));
      }),
    );

    const { result } = renderCard();
    await waitFor(() => { expect(result.current.state.status).toBe("resolved"); });

    let ok = false;
    await act(async () => {
      ok = await result.current.addRelation("WO-20260701-002");
    });
    expect(ok).toBe(true);
    expect(created).toMatchObject({ src_kind: "work_order", src_id: "wo-1", dst_kind: "work_order", link_type: "relates_to" });
    await waitFor(() => { expect(result.current.state.links.outgoing).toHaveLength(1); });
  });

  it("does not POST an unlinkable bare code (deny-by-omission)", async () => {
    let posted = false;
    server.use(
      ...baseHandlers(() => ({ outgoing: [], incoming: [] })),
      http.post("*/api/v1/object-links", () => {
        posted = true;
        return HttpResponse.json(edge("x", "y"));
      }),
    );
    const { result } = renderCard();
    await waitFor(() => { expect(result.current.state.status).toBe("resolved"); });

    let ok = true;
    await act(async () => {
      // No registered code prefix -> not a resolvable object kind.
      ok = await result.current.addRelation("ZZ-0001");
    });
    expect(ok).toBe(false);
    expect(posted).toBe(false);
  });

  it("removes a relation via a real DELETE, then reloads links", async () => {
    let deletedId: string | null = null;
    let links: { outgoing: unknown[]; incoming: unknown[] } = { outgoing: [edge("lnk-1", "AP-3121")], incoming: [] };
    server.use(
      ...baseHandlers(() => links),
      http.delete("*/api/v1/object-links/:id", ({ params }) => {
        deletedId = String(params.id);
        links = { outgoing: [], incoming: [] };
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { result } = renderCard();
    await waitFor(() => { expect(result.current.state.links.outgoing).toHaveLength(1); });

    let ok = false;
    await act(async () => {
      ok = await result.current.removeRelation("lnk-1");
    });
    expect(ok).toBe(true);
    expect(deletedId).toBe("lnk-1");
    await waitFor(() => { expect(result.current.state.links.outgoing).toHaveLength(0); });
  });
});
