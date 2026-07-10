import { describe, expect, it } from "vitest";

import {
  applySchemaEdit,
  approveRevision,
  createDraftType,
  discardRevision,
  initialRegistryState,
  isStaged,
  schemaStageTone,
  viewOf,
} from "./model";
import type { OntObjectTypeDef } from "./types";

function typeDef(overrides: Partial<OntObjectTypeDef>): OntObjectTypeDef {
  return {
    id: "t1",
    stableKey: "t1",
    code: "OT-01",
    title: "Type One",
    backingKind: "instance",
    schemaVersion: 1,
    lifecycleState: "draft",
    properties: [],
    links: [],
    actions: [],
    analytics: [],
    instances: [],
    acting: [],
    ...overrides,
  };
}

const propertyEdit = {
  kind: "property" as const,
  def: { key: "p1", title: "Prop", type: "text" as const, required: false },
};

describe("ontology revision-staging model (§3.9.0)", () => {
  it("edits draft types directly without staging", () => {
    const state = initialRegistryState([typeDef({ lifecycleState: "draft" })]);
    const next = applySchemaEdit(state, "t1", propertyEdit);
    expect(isStaged(next, "t1")).toBe(false);
    expect(viewOf(next, "t1")?.properties).toHaveLength(1);
    expect(next.types[0].properties).toHaveLength(1);
    expect(next.types[0].schemaVersion).toBe(1);
  });

  it("stages a v+1 copy when editing a published type, leaving committed untouched", () => {
    const state = initialRegistryState([typeDef({ lifecycleState: "published", schemaVersion: 2 })]);
    const next = applySchemaEdit(state, "t1", propertyEdit);
    expect(isStaged(next, "t1")).toBe(true);
    expect(viewOf(next, "t1")?.properties).toHaveLength(1);
    expect(next.types[0].properties).toHaveLength(0);
    expect(next.types[0].schemaVersion).toBe(2);
  });

  it("accumulates subsequent edits on the same staged copy", () => {
    const state = initialRegistryState([typeDef({ lifecycleState: "published" })]);
    const once = applySchemaEdit(state, "t1", propertyEdit);
    const twice = applySchemaEdit(once, "t1", {
      kind: "action",
      def: { stableKey: "a1", title: "Act", dispatch: "instance_revision" },
    });
    const view = viewOf(twice, "t1");
    expect(view?.properties).toHaveLength(1);
    expect(view?.actions).toHaveLength(1);
  });

  it("approveRevision commits the staged copy as schema v+1 and clears staging", () => {
    const state = applySchemaEdit(
      initialRegistryState([typeDef({ lifecycleState: "published", schemaVersion: 2 })]),
      "t1",
      propertyEdit,
    );
    const next = approveRevision(state, "t1");
    expect(isStaged(next, "t1")).toBe(false);
    expect(next.types[0].schemaVersion).toBe(3);
    expect(next.types[0].properties).toHaveLength(1);
  });

  it("discardRevision drops the staged copy, committed untouched", () => {
    const state = applySchemaEdit(
      initialRegistryState([typeDef({ lifecycleState: "published" })]),
      "t1",
      propertyEdit,
    );
    const next = discardRevision(state, "t1");
    expect(isStaged(next, "t1")).toBe(false);
    expect(viewOf(next, "t1")?.properties).toHaveLength(0);
  });

  it("approve/discard are no-ops without a staged revision", () => {
    const state = initialRegistryState([typeDef({ lifecycleState: "published" })]);
    expect(approveRevision(state, "t1")).toBe(state);
    expect(discardRevision(state, "t1")).toBe(state);
  });

  it("createDraftType appends a draft with the next free OT- code", () => {
    const state = initialRegistryState([typeDef({ code: "OT-07" })]);
    const { state: next, created } = createDraftType(state, "  New Type  ");
    expect(created?.code).toBe("OT-08");
    expect(created?.title).toBe("New Type");
    expect(created?.lifecycleState).toBe("draft");
    expect(created?.schemaVersion).toBe(1);
    expect(next.types).toHaveLength(2);
  });

  it("createDraftType rejects blank titles", () => {
    const state = initialRegistryState([typeDef({})]);
    const result = createDraftType(state, "   ");
    expect(result.created).toBeNull();
    expect(result.state).toBe(state);
  });

  it("maps every schema stage to a chip tone", () => {
    expect(schemaStageTone("draft")).toBe("neutral");
    expect(schemaStageTone("review_pending")).toBe("warn");
    expect(schemaStageTone("published")).toBe("ok");
    expect(schemaStageTone("superseded")).toBe("info");
    expect(schemaStageTone("retired")).toBe("danger");
  });
});
