export {
  DENY_ALL,
  decisionGate,
  PolicyGateContext,
  usePolicyGate,
  type PolicyDecider,
  type PolicyGate,
  type PolicyResource,
} from "./PolicyGateContext";
export {
  BulkPolicyGateProvider,
  PolicyGateProvider,
  PolicyGated,
} from "./PolicyGated";
export { DEFAULT_POLICY_GATE_STRINGS, type PolicyGateStrings } from "./strings";
// Compatibility exports for main's console-cc slices (lifecycle/module/object
// card) which consume the query-shaped policy adapter. They resolve to the same
// unified PolicyGateContext, so a single provider drives both APIs.
export { PolicyProvider, type PolicyQuery, type PolicyQueryDecider } from "./components";
export { PolicyGated as ActionPolicyGated } from "./PolicyGated";
