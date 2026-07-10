import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { PolicyGateProvider, type PolicyGate } from "../policy";
import { RelationAuthoringPanel, type ObjectGraphResponse } from "./RelationAuthoringPanel";

const TARGET = { kind: "work_order", id: "wo-1" };
const TOKEN = "relation-token";

const allowAll: PolicyGate = { can: () => true };
const viewOnly: PolicyGate = { can: (action) => action === RELATION_AUTHORING_ACTIONS.view };

const RELATION_AUTHORING_ACTIONS = {
  view: "object.view",
  linkCreate: "object.link.create",
  linkDelete: "object.link.delete",
} as const;

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => {
  server.close();
});

function graph(edges: ObjectGraphResponse["edges"] = []): ObjectGraphResponse {
  return {
    nodes: [
      {
        kind: "work_order",
        id: "wo-1",
        code: "WO-20260709-001",
        title: "펌프 점검",
        status: "ACTIVE",
        exists: true,
      },
      {
        kind: "approval_run",
        id: "AP-3121",
        code: "AP-3121",
        title: "작업 승인",
        status: "PENDING",
        exists: true,
      },
    ],
    edges,
    truncated: false,
  };
}

function relation(overrides: Partial<ObjectGraphResponse["edges"][number]> = {}): ObjectGraphResponse["edges"][number] {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    src_kind: "work_order",
    src_id: "wo-1",
    dst_kind: "approval_run",
    dst_id: "AP-3121",
    link_type: "authorized_by",
    created_by: null,
    created_at: "2026-07-09T08:00:00Z",
    ...overrides,
  };
}

function renderPanel({
  gate = allowAll,
  initialGraph = graph(),
  onGraphChange = vi.fn(),
}: {
  gate?: PolicyGate;
  initialGraph?: ObjectGraphResponse;
  onGraphChange?: (next: ObjectGraphResponse) => void;
} = {}) {
  render(
    <PolicyGateProvider gate={gate}>
      <RelationAuthoringPanel
        bearerToken={TOKEN}
        initialGraph={initialGraph}
        onGraphChange={onGraphChange}
        target={TARGET}
      />
    </PolicyGateProvider>,
  );
  return { onGraphChange };
}

describe("RelationAuthoringPanel", () => {
  it("creates an audited object link and refreshes the graph immediately", async () => {
    const createdBodies: unknown[] = [];
    const nextGraph = graph([relation({ id: "22222222-2222-4222-8222-222222222222" })]);
    let graphReads = 0;
    server.use(
      http.post("*/api/v1/object-links", async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
        createdBodies.push(await request.json());
        return HttpResponse.json(nextGraph.edges[0]);
      }),
      http.get("*/api/objects/work_order/wo-1/graph", () => {
        graphReads += 1;
        return HttpResponse.json(nextGraph);
      }),
      http.get("*/api/audit", ({ request }) => {
        expect(new URL(request.url).searchParams.get("target_id")).toBe("wo-1");
        return HttpResponse.json({
          items: [
            {
              id: "audit-1",
              action: "object_link.create",
              target_id: "wo-1",
              target_type: "object_link",
              occurred_at: "2026-07-09T08:01:00Z",
            },
          ],
        });
      }),
    );

    const { onGraphChange } = renderPanel();
    fireEvent.change(screen.getByLabelText("대상 종류"), { target: { value: "approval_run" } });
    fireEvent.change(screen.getByLabelText("대상 ID"), { target: { value: "AP-3121" } });
    fireEvent.change(screen.getByLabelText("관계 유형"), { target: { value: "authorized_by" } });
    fireEvent.click(screen.getByRole("button", { name: "관계 연결" }));

    await waitFor(() => {
      expect(screen.getByText("감사 이력 갱신됨")).toBeInTheDocument();
    });
    expect(createdBodies).toEqual([
      {
        src_kind: "work_order",
        src_id: "wo-1",
        dst_kind: "approval_run",
        dst_id: "AP-3121",
        link_type: "authorized_by",
      },
    ]);
    expect(graphReads).toBe(1);
    expect(screen.getByText("approval_run AP-3121")).toBeInTheDocument();
    expect(onGraphChange).toHaveBeenCalledWith(nextGraph);
  });

  it("removes an object link and updates the visible relation list", async () => {
    const deleted: string[] = [];
    const initialGraph = graph([relation()]);
    const nextGraph = graph([]);
    server.use(
      http.delete("*/api/v1/object-links/:id", ({ params }) => {
        deleted.push(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
      http.get("*/api/objects/work_order/wo-1/graph", () => HttpResponse.json(nextGraph)),
      http.get("*/api/audit", () => HttpResponse.json({ items: [] })),
    );

    const { onGraphChange } = renderPanel({ initialGraph });
    expect(screen.getByText("approval_run AP-3121")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "관계 해제 approval_run AP-3121" }));

    await waitFor(() => {
      expect(screen.getByText("연결된 개체 없음")).toBeInTheDocument();
    });
    expect(deleted).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(onGraphChange).toHaveBeenCalledWith(nextGraph);
  });

  it("omits create and delete affordances when PolicyGated denies relation mutations", () => {
    renderPanel({ gate: viewOnly, initialGraph: graph([relation()]) });

    expect(screen.getByText("approval_run AP-3121")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "관계 연결" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /관계 해제/ })).not.toBeInTheDocument();
  });
});
