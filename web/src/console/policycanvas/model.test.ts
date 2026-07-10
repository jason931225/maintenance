import { describe, expect, it } from "vitest";

import type {
  PolicyNoCodeBlocks,
  PolicyNoCodeCondition,
} from "../../api/policyCedar";
import {
  blocksToCanvasDoc,
  conditionsToGroup,
  decisionReason,
  groupToConditions,
  ruleLine,
} from "./model";
import { DEFAULT_POLICYCANVAS_STRINGS as S } from "./strings";
import { POLICY_BLOCK_IDS } from "./types";

const conditions: PolicyNoCodeCondition[] = [
  { attr: "owner", op: "eq", value: { kind: "subject_attr", value: "user_id" } },
  { attr: "branch", op: "ne", value: { kind: "literal", value: "seoul" } },
  { attr: "legal_hold", op: "eq", value: { kind: "bool", value: true } },
  { attr: "roles", op: "contains", value: { kind: "literal", value: "admin" } },
];

const blocks: PolicyNoCodeBlocks = {
  effect: "permit",
  action: "view",
  resource_type: "work_order",
  conditions,
};

describe("conditions ↔ predicate group mapping", () => {
  it("round-trips the full backend condition grammar", () => {
    expect(groupToConditions(conditionsToGroup(conditions))).toEqual(
      conditions,
    );
  });

  it("renders a subject_attr RHS as a principal.<attr> text value", () => {
    const group = conditionsToGroup(conditions);
    expect(group.predicates[0].value).toEqual({
      kind: "text",
      value: "principal.user_id",
    });
    expect(group.predicates[1].op).toBe("neq");
    expect(group.predicates[2].value).toEqual({ kind: "bool", value: true });
  });

  it("emits contains for subject-set fields regardless of the row op", () => {
    const out = groupToConditions({
      join: "and",
      predicates: [
        {
          id: "p1",
          field: "clearance_keys",
          op: "eq",
          value: { kind: "text", value: "sensitive_plus" },
        },
      ],
    });
    expect(out).toEqual([
      {
        attr: "clearance_keys",
        op: "contains",
        value: { kind: "literal", value: "sensitive_plus" },
      },
    ]);
  });

  it("keeps non-whitelisted principal.* text as a literal", () => {
    const out = groupToConditions({
      join: "and",
      predicates: [
        {
          id: "p1",
          field: "owner",
          op: "eq",
          value: { kind: "text", value: "principal.not_an_attr" },
        },
      ],
    });
    expect(out[0].value).toEqual({
      kind: "literal",
      value: "principal.not_an_attr",
    });
  });
});

describe("blocksToCanvasDoc", () => {
  it("renders the fixed P→R→A→E block sequence", () => {
    const doc = blocksToCanvasDoc(blocks, S);
    expect(doc.nodes.map((n) => n.id)).toEqual([
      POLICY_BLOCK_IDS.principal,
      POLICY_BLOCK_IDS.resource,
      POLICY_BLOCK_IDS.action,
      POLICY_BLOCK_IDS.effect,
    ]);
    expect(doc.nodes.map((n) => n.kind)).toEqual([
      "trigger",
      "condition",
      "action",
      "branch",
    ]);
    expect(doc.nodes[3].outputs).toHaveLength(2);
    expect(doc.edges).toHaveLength(3);
  });

  it("derives principal chips from subject-set conditions", () => {
    const doc = blocksToCanvasDoc(blocks, S);
    expect(doc.nodes[0].chips?.[0]).toContain("admin");
    expect(doc.nodes[1].chips?.[0]).toBe("work_order");
  });

  it("shows Any when no subject-set condition exists", () => {
    const doc = blocksToCanvasDoc({ ...blocks, conditions: [] }, S);
    expect(doc.nodes[0].chips).toEqual([S.any]);
  });
});

describe("ruleLine", () => {
  it("derives the NL rule line from the authored blocks", () => {
    const line = ruleLine(blocks, S);
    expect(line).toContain("work_order");
    expect(line).toContain(S.actionLabels.view);
    expect(line).toContain("permitted");
    expect(line).toContain("3"); // resource-side condition count
  });

  it("marks forbid policies as forbidden", () => {
    expect(ruleLine({ ...blocks, effect: "forbid" }, S)).toContain("forbidden");
  });
});

describe("decisionReason", () => {
  it("categorizes an allow as permit", () => {
    expect(
      decisionReason({
        effect: "allow",
        determining_policies: ["p1"],
        errors: [],
        reason: "",
      }),
    ).toBe("permit");
  });

  it("categorizes a deny with determining policies as forbid", () => {
    expect(
      decisionReason({
        effect: "deny",
        determining_policies: ["guardrail"],
        errors: [],
        reason: "",
      }),
    ).toBe("forbid");
  });

  it("categorizes a deny with no matched policy as omission", () => {
    expect(
      decisionReason({
        effect: "deny",
        determining_policies: [],
        errors: [],
        reason: "no policy matched",
      }),
    ).toBe("omission");
  });
});
