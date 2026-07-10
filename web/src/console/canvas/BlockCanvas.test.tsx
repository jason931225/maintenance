import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { BlockCanvas } from "./BlockCanvas";
import { DEFAULT_CANVAS_STRINGS } from "./strings";
import { stubCanvasDoc } from "./stub";
import type { CanvasDoc } from "./types";

const S = DEFAULT_CANVAS_STRINGS;

describe("BlockCanvas", () => {
  it("renders every node and shows the empty state when there are none", () => {
    const { rerender } = render(<BlockCanvas doc={stubCanvasDoc()} strings={S} />);
    // each node's dedicated header button carries the node name; assert ≥1 each.
    expect(screen.getAllByRole("button", { name: S.nodeAria("trigger") }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: S.nodeAria("action") }).length).toBeGreaterThan(0);

    rerender(<BlockCanvas doc={{ version: 1, nodes: [], edges: [], vars: [] }} strings={S} />);
    expect(screen.getByText(S.emptyCanvas)).toBeInTheDocument();
  });

  it("renders a branch node with its two labeled outputs", () => {
    render(<BlockCanvas doc={stubCanvasDoc()} strings={S} />);
    expect(screen.getByRole("button", { name: S.portAria("yes") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: S.portAria("no") })).toBeInTheDocument();
  });

  it("connects by activating a source port then a target node (keyboard/click path)", () => {
    function Harness() {
      const [doc, setDoc] = useState<CanvasDoc>(stubCanvasDoc());
      return <BlockCanvas doc={doc} strings={S} onChange={setDoc} />;
    }
    render(<Harness />);

    // Begin connect from the trigger's implicit "out" port (first "out" in DOM).
    fireEvent.click(screen.getAllByRole("button", { name: S.portAria("out") })[0]);
    // Complete onto the action node (no pre-existing trigger→action edge).
    const actionNode = screen.getAllByRole("button", { name: S.nodeAria("action") })[0];
    fireEvent.click(actionNode);

    // An SVG line now exists for the new edge (stub had 3, now 4).
    const lines = document.querySelectorAll("line");
    expect(lines.length).toBe(4);
  });

  it("does not mutate the doc for an invalid self-connect", () => {
    const onChange = vi.fn();
    render(<BlockCanvas doc={stubCanvasDoc()} strings={S} onChange={onChange} />);
    // Arm from trigger's port, then click the SAME trigger node → no-op.
    fireEvent.click(screen.getAllByRole("button", { name: S.portAria("out") })[0]);
    const triggerNode = screen.getAllByRole("button", { name: S.nodeAria("trigger") })[0];
    fireEvent.click(triggerNode);
    expect(onChange).not.toHaveBeenCalled();
  });
});
