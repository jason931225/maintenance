import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ObjectCardDemo, type ObjectCardDemoState } from "./ObjectCardDemo";
import type { ObjectCardState } from "./useObjectCard";

const FULL: ObjectCardState = {
  status: "resolved",
  head: { kind: "work_order", id: "wo-1", code: "WO-20260612-001", title: "지게차 정비", status: "IN_PROGRESS", exists: true },
  lifecycle: { objectType: "work_order", objectId: "wo-1", currentState: "active", legalHold: false, createdAt: "x", updatedAt: "x", transitions: [] },
  audit: [{ id: "a1", action: "work_order.update", actor: "u1", target_type: "work_order", occurred_at: "2026-07-02T09:00:00Z" }],
  links: {
    outgoing: [{ id: "lnk-1", src_kind: "work_order", src_id: "wo-1", dst_kind: "approval_run", dst_id: "AP-3121", link_type: "relates_to", created_by: null, created_at: "x" }],
    incoming: [],
  },
};

// Redacted/minimal: resolved head, but lifecycle+audit denied and no relations.
const MINIMAL: ObjectCardState = {
  status: "resolved",
  head: { kind: "support_ticket", id: "st-1", code: "CS-5001", title: null, status: null, exists: true },
  lifecycle: null,
  audit: null,
  links: { outgoing: [], incoming: [] },
};

function renderDemo(state: ObjectCardDemoState) {
  return render(<ObjectCardDemo state={state} full={FULL} minimal={MINIMAL} />);
}

describe("ObjectCardDemo (fidelity states)", () => {
  it("renders the full 3-layer state with all layers and mutation affordances", () => {
    const { container } = renderDemo("full");
    expect(container.querySelector('[data-fidelity="objectcard-full"]')).toBeInTheDocument();
    expect(screen.getByText("의미")).toBeInTheDocument();
    expect(screen.getByText("동작")).toBeInTheDocument();
    expect(screen.getByText("역학")).toBeInTheDocument();
    expect(screen.getByText("관계 연결")).toBeInTheDocument();
  });

  it("renders the redacted/minimal state — layer 2 omitted, no mutation affordances", () => {
    const { container } = renderDemo("minimal");
    expect(container.querySelector('[data-fidelity="objectcard-minimal"]')).toBeInTheDocument();
    expect(screen.getByText("의미")).toBeInTheDocument();
    expect(screen.queryByText("동작")).not.toBeInTheDocument();
    expect(screen.queryByText("관계 연결")).not.toBeInTheDocument();
  });
});
