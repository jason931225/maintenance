import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { PredicateEditor } from "./PredicateEditor";
import { DEFAULT_CANVAS_STRINGS } from "./strings";
import { STUB_FIELD_REGISTRY } from "./stub";
import type { PredicateGroup } from "./types";

const S = DEFAULT_CANVAS_STRINGS;

function Harness({ initial, onSnapshot }: { initial: PredicateGroup; onSnapshot?: (g: PredicateGroup) => void }) {
  const [group, setGroup] = useState(initial);
  return (
    <PredicateEditor
      group={group}
      registry={STUB_FIELD_REGISTRY}
      strings={S}
      onChange={(g) => {
        setGroup(g);
        onSnapshot?.(g);
      }}
    />
  );
}

const empty: PredicateGroup = { join: "and", predicates: [] };

describe("PredicateEditor", () => {
  it("adds a typed row seeded from the first registry field", () => {
    let latest: PredicateGroup | undefined;
    render(<Harness initial={empty} onSnapshot={(g) => (latest = g)} />);
    fireEvent.click(screen.getByText(S.addPredicate));
    expect(latest?.predicates).toHaveLength(1);
    // First field is a number → operator ≥, value kind number.
    expect(latest?.predicates[0]).toMatchObject({ field: "absence_count", op: "gte", value: { kind: "number" } });
  });

  it("constrains operators to the field type and re-seeds the value on field change", () => {
    let latest: PredicateGroup | undefined;
    const initial: PredicateGroup = {
      join: "and",
      predicates: [{ id: "r1", field: "absence_count", op: "gte", value: { kind: "number", value: 0 } }],
    };
    render(<Harness initial={initial} onSnapshot={(g) => (latest = g)} />);

    // Switch the field to the enum "priority" → value becomes enum, op = eq.
    fireEvent.change(screen.getByLabelText(S.fieldLabel), { target: { value: "priority" } });
    expect(latest?.predicates[0]).toMatchObject({ field: "priority", op: "eq", value: { kind: "enum" } });

    // Operator select now offers ∈ (enum admits eq/neq/in).
    const opSelect = screen.getByLabelText(S.operatorLabel);
    fireEvent.change(opSelect, { target: { value: "in" } });
    expect(latest?.predicates[0].value.kind).toBe("enumSet");
  });

  it("accepts an object-code value via an objDrag drop", () => {
    let latest: PredicateGroup | undefined;
    const initial: PredicateGroup = {
      join: "and",
      predicates: [{ id: "c1", field: "work_order", op: "eq", value: { kind: "code", value: "" } }],
    };
    render(<Harness initial={initial} onSnapshot={(g) => (latest = g)} />);

    const input = screen.getByLabelText(S.valueLabel);
    const data = new Map<string, string>([["text/plain", "[WO-2643 유압 점검]"]]);
    fireEvent.drop(input, {
      dataTransfer: { getData: (t: string) => data.get(t) ?? "", types: ["text/plain"] },
    });
    expect(latest?.predicates[0].value).toEqual({ kind: "code", value: "WO-2643" });
  });

  it("removes a row", () => {
    let latest: PredicateGroup | undefined;
    const initial: PredicateGroup = {
      join: "and",
      predicates: [{ id: "r1", field: "absence_count", op: "gte", value: { kind: "number", value: 0 } }],
    };
    render(<Harness initial={initial} onSnapshot={(g) => (latest = g)} />);
    fireEvent.click(screen.getByLabelText(S.removePredicate));
    expect(latest?.predicates).toHaveLength(0);
  });
});
