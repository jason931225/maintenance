// Carbon-copy console policy gate — context + hook (charter founder directive 3:
// "EVERY rendered affordance routes through the shared policy-gate primitive").
//
// ponytail: the canonical shared gate is built by the sibling P0 lane
// (feat/console-cc-policy-gate) at this same path. That lane is unmerged while
// this slice is in flight, so this ships the SAME interface
// (usePolicyGate / PolicyGated) that LifecycleCard codes against. Convergence
// when it merges: replace this with that lane's implementation, keep the import
// specifiers. The real gate is /me/authz-backed with true deny-by-omission; this
// local one defaults to deny when no provider wraps the tree (fail-closed) and
// is driven by a caller-supplied decider (JWT role hint) in LifecycleCard.

import { createContext, useContext } from "react";

/** A policy question: an action verb, optionally about a specific resource. */
export interface PolicyQuery {
  action: string;
  resource?: string;
}

/** Returns true iff the current principal may perform the queried action. */
export type PolicyDecider = (query: PolicyQuery) => boolean;

export const PolicyContext = createContext<PolicyDecider>(() => false);

/** The shared hook every console affordance consults before rendering/enabling. */
export function usePolicyGate(): PolicyDecider {
  return useContext(PolicyContext);
}
