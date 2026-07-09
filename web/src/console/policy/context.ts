// Back-compat exports for query-shaped policy callers. The canonical runtime
// context lives in ./usePolicyGate so object-card and lifecycle share one gate.

export { type PolicyQuery, type PolicyQueryDecider } from "./components";
