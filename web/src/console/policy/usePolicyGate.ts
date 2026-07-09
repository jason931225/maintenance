import { createContext, useContext } from "react";

/**
 * Shared policy-gate primitive — hook + context (charter founder directive 3:
 * "EVERY rendered affordance routes through the shared policy-gate primitive").
 *
 * ⚠ CONVERGENCE NOTE (ponytail): the canonical implementation is owned by a
 * sibling P0 lane building out `web/src/console/policy/`. This is a MINIMAL
 * local implementation of the same interface; when that lane merges, delete
 * these files and re-point imports at the canonical primitive — the interface
 * (a `PolicyDecider` context + a `<PolicyGated>` deny-by-omission wrapper) is
 * designed to match so the swap is import-only.
 *
 * Semantics (DESIGN §4.5, deny-by-omission): a denied affordance renders
 * NOTHING. This is a UI-only projection; the backend RLS/PBAC layer is the real
 * authority. The default decider (no provider) is permissive because a
 * standalone primitive has no policy source; a real screen wraps its subtree in
 * a `PolicyGateProvider` fed from the session's authorization projection.
 */
export type PolicyDecider = (action: string) => boolean;

const ALLOW_ALL: PolicyDecider = () => true;

export const PolicyGateContext = createContext<PolicyDecider | null>(null);

/** The active decider. Falls back to allow-all when no provider wraps the tree
 * (see the convergence note); real screens always provide one. */
export function usePolicyGate(): PolicyDecider {
  return useContext(PolicyGateContext) ?? ALLOW_ALL;
}
