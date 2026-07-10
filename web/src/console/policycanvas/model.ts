// Pure policy-canvas logic: the API no-code blocks payload ↔ the shared
// canvas primitives (CanvasDoc for display, PredicateGroup for editing), the
// NL rule line, and the presentation category of a §5c decision. The decision
// itself always comes from POST /policy/simulate — there is no local evaluator.

import type {
  PolicyConditionRhs,
  PolicyNoCodeBlocks,
  PolicyNoCodeCondition,
  PolicySimulationOutcome,
} from "../../api/policyCedar";
import type { CanvasDoc, FieldRegistry, PredicateGroup } from "../canvas";
import type { PolicyCanvasStrings } from "./strings";
import { DEFAULT_CONDITION_FIELD_LABELS } from "./strings";
import type { SimulationReason } from "./types";
import {
  POLICY_BLOCK_IDS,
  RESOURCE_CONDITION_ATTRS,
  SUBJECT_ATTRS,
  SUBJECT_SET_ATTRS,
} from "./types";

function conditionFieldLabel(s: PolicyCanvasStrings, key: string): string {
  return s.conditionFields?.[key] ?? DEFAULT_CONDITION_FIELD_LABELS[key] ?? key;
}

/**
 * Condition field registry for the shared PredicateEditor — exactly the attrs
 * the backend authoring schema whitelists. Subject sets (`roles`,
 * `clearance_keys`) are `contains` conditions; the editor shows them as text
 * equality rows and the mapping emits the `contains` op.
 */
export function conditionFieldRegistry(s: PolicyCanvasStrings): FieldRegistry {
  return [
    { key: "resource_type", label: conditionFieldLabel(s, "resource_type"), type: "text" },
    { key: "owner", label: conditionFieldLabel(s, "owner"), type: "text" },
    { key: "branch", label: conditionFieldLabel(s, "branch"), type: "text" },
    { key: "legal_hold", label: conditionFieldLabel(s, "legal_hold"), type: "bool" },
    { key: "roles", label: conditionFieldLabel(s, "roles"), type: "text" },
    { key: "clearance_keys", label: conditionFieldLabel(s, "clearance_keys"), type: "text" },
  ];
}

const SUBJECT_ATTR_PREFIX = "principal.";

function isSubjectSetAttr(attr: string): boolean {
  return (SUBJECT_SET_ATTRS as readonly string[]).includes(attr);
}

/** Narrow the wire condition value to the tagged RHS the backend serializes. */
function conditionRhs(condition: PolicyNoCodeCondition): PolicyConditionRhs {
  const { kind, value } = condition.value as {
    kind?: unknown;
    value?: unknown;
  };
  if (kind === "bool" && typeof value === "boolean") {
    return { kind: "bool", value };
  }
  if (kind === "subject_attr" && typeof value === "string") {
    return { kind: "subject_attr", value };
  }
  return { kind: "literal", value: typeof value === "string" ? value : "" };
}

/**
 * Wire conditions → editable predicate rows. A `subject_attr` RHS round-trips
 * as the text `principal.<attr>`; a `contains` op is carried by the subject-set
 * field itself (roles/clearance_keys), so the row shape stays field·op·value.
 */
export function conditionsToGroup(
  conditions: readonly PolicyNoCodeCondition[],
): PredicateGroup {
  return {
    join: "and",
    predicates: conditions.map((condition, index) => {
      const rhs = conditionRhs(condition);
      if (rhs.kind === "bool") {
        return {
          id: `cond-${String(index)}`,
          field: condition.attr,
          op: "eq" as const,
          value: { kind: "bool" as const, value: rhs.value },
        };
      }
      return {
        id: `cond-${String(index)}`,
        field: condition.attr,
        op: condition.op === "ne" ? ("neq" as const) : ("eq" as const),
        value: {
          kind: "text" as const,
          value:
            rhs.kind === "subject_attr"
              ? `${SUBJECT_ATTR_PREFIX}${rhs.value}`
              : rhs.value,
        },
      };
    }),
  };
}

/** Editable predicate rows → wire conditions (the exact backend grammar). */
export function groupToConditions(
  group: PredicateGroup,
): PolicyNoCodeCondition[] {
  return group.predicates.map((predicate) => {
    if (predicate.value.kind === "bool") {
      return {
        attr: predicate.field,
        op: "eq" as const,
        value: { kind: "bool", value: predicate.value.value },
      };
    }
    const raw =
      typeof predicate.value.value === "string" ? predicate.value.value : "";
    const subjectAttr = raw.startsWith(SUBJECT_ATTR_PREFIX)
      ? raw.slice(SUBJECT_ATTR_PREFIX.length)
      : null;
    const value: PolicyConditionRhs =
      subjectAttr && (SUBJECT_ATTRS as readonly string[]).includes(subjectAttr)
        ? { kind: "subject_attr", value: subjectAttr }
        : { kind: "literal", value: raw };
    return {
      attr: predicate.field,
      op: isSubjectSetAttr(predicate.field)
        ? ("contains" as const)
        : predicate.op === "neq"
          ? ("ne" as const)
          : ("eq" as const),
      value,
    };
  });
}

function conditionChip(
  condition: PolicyNoCodeCondition,
  s: PolicyCanvasStrings,
): string {
  const rhs = conditionRhs(condition);
  const value =
    rhs.kind === "bool"
      ? String(rhs.value)
      : rhs.kind === "subject_attr"
        ? `${SUBJECT_ATTR_PREFIX}${rhs.value}`
        : rhs.value;
  return `${conditionFieldLabel(s, condition.attr)} ${condition.op === "ne" ? "≠" : condition.op === "contains" ? "∋" : "="} ${value}`;
}

function principalChips(
  blocks: PolicyNoCodeBlocks,
  s: PolicyCanvasStrings,
): string[] {
  const chips = (blocks.conditions ?? [])
    .filter((condition) => isSubjectSetAttr(condition.attr))
    .map((condition) => conditionChip(condition, s));
  return chips.length > 0 ? chips : [s.any];
}

function resourceConditions(
  blocks: PolicyNoCodeBlocks,
): PolicyNoCodeCondition[] {
  return (blocks.conditions ?? []).filter((condition) =>
    (RESOURCE_CONDITION_ATTRS as readonly string[]).includes(condition.attr),
  );
}

export function actionLabel(s: PolicyCanvasStrings, action: string): string {
  return s.actionLabels[action] ?? action;
}

/** Fixed P→R→A→E block sequence rendered by the shared BlockCanvas. */
export function blocksToCanvasDoc(
  blocks: PolicyNoCodeBlocks,
  s: PolicyCanvasStrings,
): CanvasDoc {
  return {
    version: 1,
    nodes: [
      {
        id: POLICY_BLOCK_IDS.principal,
        kind: "trigger",
        title: s.blocks.principal,
        chips: principalChips(blocks, s),
      },
      {
        id: POLICY_BLOCK_IDS.resource,
        kind: "condition",
        title: s.blocks.resource,
        chips: [
          blocks.resource_type || s.any,
          ...resourceConditions(blocks).map((condition) =>
            conditionChip(condition, s),
          ),
        ],
        predicate: conditionsToGroup(blocks.conditions ?? []),
      },
      {
        id: POLICY_BLOCK_IDS.action,
        kind: "action",
        title: s.blocks.action,
        chips: [actionLabel(s, blocks.action)],
      },
      {
        id: POLICY_BLOCK_IDS.effect,
        kind: "branch",
        title: s.blocks.effect,
        chips: [s.effectLabels[blocks.effect]],
        outputs: [
          { port: "permit", label: s.effectLabels.permit },
          { port: "forbid", label: s.effectLabels.forbid },
        ],
      },
    ],
    edges: [
      {
        id: "e-principal-resource",
        from: POLICY_BLOCK_IDS.principal,
        to: POLICY_BLOCK_IDS.resource,
      },
      {
        id: "e-resource-action",
        from: POLICY_BLOCK_IDS.resource,
        to: POLICY_BLOCK_IDS.action,
      },
      {
        id: "e-action-effect",
        from: POLICY_BLOCK_IDS.action,
        to: POLICY_BLOCK_IDS.effect,
      },
    ],
    vars: [],
  };
}

/** The generated NL rule line — derived from the authored blocks. */
export function ruleLine(
  blocks: PolicyNoCodeBlocks,
  s: PolicyCanvasStrings,
): string {
  return s.nlRule({
    who: principalChips(blocks, s).join(s.listSeparator),
    what: blocks.resource_type || s.any,
    actions: actionLabel(s, blocks.action),
    conditionCount: resourceConditions(blocks).length,
    effect: blocks.effect,
  });
}

/**
 * §5c presentation category of an API decision: forbid won (deny with
 * determining policies), permit matched (allow), or deny-by-omission.
 */
export function decisionReason(
  outcome: PolicySimulationOutcome,
): SimulationReason {
  if (outcome.effect === "allow") return "permit";
  return outcome.determining_policies.length > 0 ? "forbid" : "omission";
}
