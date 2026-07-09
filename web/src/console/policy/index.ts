export { PolicyGated, PolicyGateProvider } from "./PolicyGated";
export { PolicyProvider, type PolicyQuery, type PolicyQueryDecider } from "./components";
export {
  usePolicyGate,
  DENY_ALL,
  type PolicyGate,
  type PolicyDecider,
  type PolicyResource,
} from "./usePolicyGate";

export {
  PolicyGated as FeaturePolicyGated,
  PolicyGateProvider as FeaturePolicyGateProvider,
  PolicyGateContext as FeaturePolicyGateContext,
  usePolicyGate as useFeaturePolicyGate,
} from "./PolicyGate";
export {
  gateAllows,
  makePolicyGate,
  parseAuthzResponse,
  jwtFloorProjection,
  fetchAuthzProjection,
  DENY_ALL_PROJECTION,
  type PolicyGate as FeaturePolicyGate,
  type AuthzProjection,
  type Capability,
  type BranchScope,
  type Permission,
  type PolicyQuery as FeaturePolicyQuery,
} from "./authz";
export { PolicyProvider as ActionPolicyProvider } from "./components";
export { PolicyGated as ActionPolicyGated } from "./PolicyGated";
