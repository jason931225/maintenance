import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ko } from "../../i18n/ko";
import { PolicyGateProvider, type PolicyGate } from "../policy";
import { ObjectCard } from "./ObjectCard";
import { createObjectCardStub } from "./stub";
import { OBJECT_CARD_ACTIONS, type ObjectCardHandlers } from "./types";

const T = ko.console.objectcard;
const allowGate: PolicyGate = { can: () => true };

function renderCard(gate: PolicyGate, handlers?: ObjectCardHandlers, descriptor = createObjectCardStub()) {
  return render(
    <PolicyGateProvider gate={gate}>
      <ObjectCard descriptor={descriptor} handlers={handlers} />
    </PolicyGateProvider>,
  );
}

describe("ObjectCard three-layer structure", () => {
  it("renders the semantic, kinetic, and dynamic layer headings", () => {
    renderCard(allowGate);
    expect(screen.getByText(T.layers.semantic)).toBeTruthy();
    expect(screen.getByText(T.layers.kinetic)).toBeTruthy();
    expect(screen.getByText(T.layers.dynamic)).toBeTruthy();
  });
});

describe("ObjectCard property-policy deny-by-omission", () => {
  it("hides a property-policy field when the subject cannot read it", () => {
    // deny only the policy-gated 'cost' property; everything else allowed.
    const gate: PolicyGate = {
      can: (action, resource) =>
        !(
          action === OBJECT_CARD_ACTIONS.propertyRead &&
          typeof resource === "object" &&
          resource.id === "cost"
        ),
    };
    renderCard(gate);
    expect(screen.getByText(T.samples.props.priority)).toBeTruthy();
    expect(screen.queryByText(T.samples.props.cost)).toBeNull();
  });

  it("shows the property-policy field when read is allowed", () => {
    renderCard(allowGate);
    expect(screen.getByText(T.samples.props.cost)).toBeTruthy();
  });
});

describe("ObjectCard §20 override vs draft-direct chip", () => {
  it("shows the override chip on a non-draft object", () => {
    renderCard(allowGate, undefined, createObjectCardStub({ lifecycleState: "active" }));
    expect(screen.getAllByText(T.edit.override).length).toBeGreaterThan(0);
  });

  it("shows the direct-edit chip on a draft object", () => {
    renderCard(allowGate, undefined, createObjectCardStub({ lifecycleState: "draft" }));
    expect(screen.getAllByText(T.edit.direct).length).toBeGreaterThan(0);
  });

  it("requires a reason before an override edit commits", () => {
    const onEdit = vi.fn();
    renderCard(allowGate, { onEdit }, createObjectCardStub({ lifecycleState: "active" }));
    // open the override banner (the toggle button carries the override label)
    fireEvent.click(screen.getByRole("button", { name: T.edit.override }));
    fireEvent.click(screen.getByRole("button", { name: T.edit.apply }));
    expect(onEdit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(T.edit.reasonLabel), { target: { value: "감사 정정" } });
    fireEvent.click(screen.getByRole("button", { name: T.edit.apply }));
    expect(onEdit).toHaveBeenCalledWith({ mode: "override", reason: "감사 정정" });
  });
});

describe("ObjectCard relation drawing + actions", () => {
  it("draws an edge from a typed code on Enter", () => {
    const onRelationAdd = vi.fn();
    renderCard(allowGate, { onRelationAdd });
    const input = screen.getByLabelText(T.relations.codeLabel);
    fireEvent.change(input, { target: { value: "AT-CHO" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRelationAdd).toHaveBeenCalledWith({ code: "AT-CHO", title: "AT-CHO", linkType: "relates_to" });
  });

  it("invokes an action through the audited execute stub", () => {
    const onAction = vi.fn();
    renderCard(allowGate, { onAction });
    fireEvent.click(screen.getByRole("button", { name: T.actionAria(T.samples.actions.reassign) }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ key: "reassign" }), {});
  });

  it("gates the action button behind the execute policy (deny-by-omission)", () => {
    const denyExecute: PolicyGate = { can: (action) => action !== OBJECT_CARD_ACTIONS.actionExecute };
    renderCard(denyExecute);
    expect(
      screen.queryByRole("button", { name: T.actionAria(T.samples.actions.reassign) }),
    ).toBeNull();
  });

  it("removes an edge by link id", () => {
    const onRelationRemove = vi.fn();
    renderCard(allowGate, { onRelationRemove });
    const removeButtons = screen.getAllByText(T.relations.remove);
    fireEvent.click(removeButtons[0]);
    expect(onRelationRemove).toHaveBeenCalledWith("lnk-1");
  });
});
