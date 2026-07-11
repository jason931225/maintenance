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

  it("never labels an implicit output port with the raw 'out' machine key", () => {
    render(<BlockCanvas doc={stubCanvasDoc()} strings={S} />);
    // The implicit output is reachable by its neutral glyph label…
    expect(screen.getAllByRole("button", { name: S.portAria("→") }).length).toBeGreaterThan(0);
    // …and the machine key never leaks into the UI as a port name.
    expect(screen.queryByRole("button", { name: S.portAria("out") })).toBeNull();
  });

  it("connects by activating a source port then a target node (keyboard/click path)", () => {
    function Harness() {
      const [doc, setDoc] = useState<CanvasDoc>(stubCanvasDoc());
      return <BlockCanvas doc={doc} strings={S} onChange={setDoc} />;
    }
    render(<Harness />);

    // Begin connect from the trigger's implicit output port — rendered as a
    // neutral flow glyph, never the raw "out" machine key (first in DOM).
    fireEvent.click(screen.getAllByRole("button", { name: S.portAria("→") })[0]);
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
    fireEvent.click(screen.getAllByRole("button", { name: S.portAria("→") })[0]);
    const triggerNode = screen.getAllByRole("button", { name: S.nodeAria("trigger") })[0];
    fireEvent.click(triggerNode);
    expect(onChange).not.toHaveBeenCalled();
  });
});
