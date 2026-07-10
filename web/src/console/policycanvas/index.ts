// No-code Cedar policy canvas (ko.console.policycanvas), wired to the real
// REST surface via src/api/policyCedar.ts. Mount, in short:
//   <PolicyCanvasScreen
//     api={api}
//     orgId={session.org_id ?? ""}
//     strings={ko.console.policycanvas}
//     canvasStrings={ko.console.canvas}
//   />

export {
  PolicyCanvasScreen,
  type PolicyCanvasScreenProps,
} from "./PolicyCanvasScreen";
export {
  DEFAULT_POLICYCANVAS_STRINGS,
  DEFAULT_POLICYCANVAS_WIRE_STRINGS,
  type PolicyCanvasStrings,
  type PolicyCanvasWireStrings,
} from "./strings";
export {
  blocksToCanvasDoc,
  conditionFieldRegistry,
  conditionsToGroup,
  decisionReason,
  groupToConditions,
  ruleLine,
} from "./model";
export {
  POLICY_ACTIONS,
  POLICY_BLOCK_IDS,
  POLICY_CANVAS_ACTIONS,
  RESOURCE_CONDITION_ATTRS,
  SUBJECT_ATTRS,
  SUBJECT_SET_ATTRS,
  type PolicyAction,
  type PolicyBlockId,
  type PolicyEffect,
  type PolicyWorkingDoc,
  type SimulationReason,
} from "./types";
