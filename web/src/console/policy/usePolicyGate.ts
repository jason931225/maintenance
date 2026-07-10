// Unified policy-gate primitive. HEAD's overhaul and main's console-cc slices
// each shipped a near-identical PolicyGateContext; this file re-exports the
// single source in ./PolicyGateContext so every provider and gate shares ONE
// React context (a duplicate createContext would silently deny every gated
// control whenever a provider and a consumer came from different modules).
export {
  DENY_ALL,
  PolicyGateContext,
  usePolicyGate,
  type PolicyDecider,
  type PolicyGate,
  type PolicyResource,
} from "./PolicyGateContext";
