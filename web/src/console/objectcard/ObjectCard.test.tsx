import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PolicyGateProvider, type PolicyGate } from "../policy";
import { ObjectCardView } from "./ObjectCard";
import type { ObjectCardState, ObjectHead, ObjectLinkResponse } from "./useObjectCard";

const TARGET = { kind: "work_order", id: "wo-1" };

function head(overrides: Partial<ObjectHead> = {}): ObjectHead {
  return { kind: "work_order", id: "wo-1", code: "WO-20260612-001", title: "지게차 정비", status: "IN_PROGRESS", exists: true, ...overrides };
}

function link(overrides: Partial<ObjectLinkResponse> = {}): ObjectLinkResponse {
  return {
    id: "lnk-1",
    src_kind: "work_order",
    src_id: "wo-1",
    dst_kind: "approval_run",
    dst_id: "AP-3121",
    link_type: "relates_to",
    created_by: null,
    created_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

function resolved(overrides: Partial<ObjectCardState> = {}): ObjectCardState {
  return {
    status: "resolved",
    head: head(),
    lifecycle: {
      objectType: "work_order",
      objectId: "wo-1",
      currentState: "active",
      legalHold: false,
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-01T00:00:00Z",
      transitions: [],
    },
    audit: [
      { id: "a1", action: "work_order.update", actor: "u1", target_type: "work_order", occurred_at: "2026-07-02T09:00:00Z" },
    ],
    links: { outgoing: [link()], incoming: [] },
    ...overrides,
  };
}

const ALLOW_ALL: PolicyGate = { can: () => true };

function renderView(state: ObjectCardState, gate: PolicyGate = ALLOW_ALL) {
  return render(
    <PolicyGateProvider gate={gate}>
      <ObjectCardView
        state={state}
        target={TARGET}
        onOpenObject={() => undefined}
        onAddRelation={() => Promise.resolve(true)}
        onRemoveRelation={() => Promise.resolve(true)}
      />
    </PolicyGateProvider>,
  );
}

describe("ObjectCardView — 3-layer render", () => {
  it("renders all three layers from a resolved payload", () => {
    const { container } = renderView(resolved());
    expect(container.querySelector("[data-objectcard]")).toBeInTheDocument();
    // Layer 1 의미: attributes (code shows in header + kv row).
    expect(screen.getByText("의미")).toBeInTheDocument();
    expect(screen.getAllByText("WO-20260612-001").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("IN_PROGRESS")).toBeInTheDocument();
    // Layer 2 동작: lifecycle chip + audit row.
    expect(screen.getByText("동작")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("work_order.update")).toBeInTheDocument();
    // Layer 3 역학: relation to AP-3121.
    expect(screen.getByText("역학")).toBeInTheDocument();
    expect(screen.getByText("AP-3121", { exact: false })).toBeInTheDocument();
  });

  it("shows a legal-hold badge only when the lifecycle is on hold", () => {
    const { unmount } = renderView(resolved());
    expect(screen.queryByText("법적 보존")).not.toBeInTheDocument();
    unmount();
    renderView(
      resolved({ lifecycle: { objectType: "work_order", objectId: "wo-1", currentState: "archived", legalHold: true, createdAt: "x", updatedAt: "x", transitions: [] } }),
    );
    expect(screen.getByText("법적 보존")).toBeInTheDocument();
  });

  it("omits layer 2 entirely when both lifecycle and audit are denied (null)", () => {
    renderView(resolved({ lifecycle: null, audit: null }));
    expect(screen.queryByText("동작")).not.toBeInTheDocument();
  });
});

describe("ObjectCardView — deny-by-omission", () => {
  it("renders nothing for an object that does not resolve (absent)", () => {
    const { container } = renderView({ status: "absent", head: head({ exists: false }), lifecycle: null, audit: null, links: { outgoing: [], incoming: [] } });
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing while loading and on error", () => {
    const base = { lifecycle: null, audit: null, links: { outgoing: [], incoming: [] } } as const;
    const { container: loading } = renderView({ status: "loading", ...base });
    expect(loading).toBeEmptyDOMElement();
    const { container: errored } = renderView({ status: "error", ...base });
    expect(errored).toBeEmptyDOMElement();
  });
});

describe("ObjectCardView — policy omission", () => {
  it("hides the add-relation and remove affordances when the gate denies the mutations", () => {
    const viewOnly: PolicyGate = { can: (action) => action === "object.view" };
    renderView(resolved(), viewOnly);
    // The relation is still shown (visible data), but no mutation controls.
    expect(screen.getByText("AP-3121", { exact: false })).toBeInTheDocument();
    expect(screen.queryByText("관계 연결")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /관계 해제/ })).not.toBeInTheDocument();
  });



  it("renders an empty dynamics layer only when relations loaded as empty", () => {
    renderView(resolved({ links: { outgoing: [], incoming: [] } }));
    expect(screen.getByText("역학")).toBeInTheDocument();
    expect(screen.getByText("연결된 개체 없음")).toBeInTheDocument();
  });

  it("omits the dynamics layer when relation reads are denied or failed", () => {
    renderView(resolved({ links: null }));
    expect(screen.queryByText("역학")).not.toBeInTheDocument();
    expect(screen.queryByText("연결된 개체 없음")).not.toBeInTheDocument();
  });

  it("renders the mutation affordances when the gate allows them", () => {
    renderView(resolved());
    expect(screen.getByText("관계 연결")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /관계 해제/ })).toBeInTheDocument();
  });

  it("keeps a failed remove visible as feedback", async () => {
    render(
      <PolicyGateProvider gate={ALLOW_ALL}>
        <ObjectCardView
          state={resolved()}
          target={TARGET}
          onOpenObject={() => undefined}
          onAddRelation={() => Promise.resolve(true)}
          onRemoveRelation={() => Promise.resolve(false)}
        />
      </PolicyGateProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /관계 해제/ }));

    await waitFor(() => { expect(screen.getByText("해제 실패")).toBeInTheDocument(); });
  });

  it("renders the related object as a clickable open button only when view is permitted", () => {
    const { unmount } = renderView(resolved());
    expect(screen.getByRole("button", { name: /열기/ })).toBeInTheDocument();
    unmount();
    const noView: PolicyGate = { can: (action) => action !== "object.view" };
    renderView(resolved(), noView);
    expect(screen.queryByRole("button", { name: /열기/ })).not.toBeInTheDocument();
  });
});
