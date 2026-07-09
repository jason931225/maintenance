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
 * authority. The default decider (no provider) DENIES everything: an unprovided
 * gate must never leak an affordance. Every real screen wraps its subtree in a
 * `PolicyGateProvider` fed from the session's authorization projection; a demo
 * or harness that deliberately wants all affordances visible mounts an explicit
 * allow-all provider (never relies on the default).
 */
export type PolicyDecider = (action: string) => boolean;

const DENY_ALL: PolicyDecider = () => false;

export const PolicyGateContext = createContext<PolicyDecider | null>(null);

/** The active decider. Falls back to DENY-all when no provider wraps the tree —
 * fail-closed, so a forgotten provider hides affordances rather than exposing
 * them. Real screens (and demos wanting visible affordances) always provide one. */
export function usePolicyGate(): PolicyDecider {
  return useContext(PolicyGateContext) ?? DENY_ALL;
}
