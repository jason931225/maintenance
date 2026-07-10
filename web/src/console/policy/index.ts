export {
  DENY_ALL,
  PolicyGateContext,
  usePolicyGate,
  type PolicyDecider,
  type PolicyGate,
  type PolicyResource,
} from "./PolicyGateContext";
export { PolicyGateProvider, PolicyGated } from "./PolicyGated";
// Compatibility exports for main's console-cc slices (lifecycle/module/object
// card) which consume the query-shaped policy adapter. They resolve to the same
// unified PolicyGateContext, so a single provider drives both APIs.
export { PolicyProvider, type PolicyQuery, type PolicyQueryDecider } from "./components";
export { PolicyGated as ActionPolicyGated } from "./PolicyGated";
