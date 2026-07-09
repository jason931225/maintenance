import { createContext, useContext } from "react";

/**
 * Shared policy-gate primitive (charter P0 §3, founder directive 3): EVERY
 * rendered affordance in the console routes through this so nothing draws that
 * the viewer isn't permitted (deny-by-omission, DESIGN §4.5).
 *
 * ponytail: MINIMAL LOCAL IMPLEMENTATION. A sibling lane in this wave owns the
 * real, Cedar/JWT-backed `web/src/console/policy/` module. This file ships the
 * SAME interface (`PolicyGated`, `usePolicyGate`) so consumers code against the
 * contract now; when the real gate merges it replaces this module keeping the
 * interface. The default context value is deny-all — a real decision arrives
 * only via a mounted `PolicyGateProvider` (the live app wires the real gate;
 * demos/tests inject an explicit decider). The hook/context/types live here
 * (no JSX) and the components in `PolicyGated.tsx` so react-refresh stays happy.
 * Convergence note (ponytail): re-point imports if the sibling lane lands a
 * different file layout under `policy/`.
 */

export interface PolicyResource {
  kind: string;
  id: string;
}

/** Returns whether `action` on the (optional) resource is permitted. */
export type PolicyDecider = (action: string, resource?: PolicyResource) => boolean;

export interface PolicyGate {
  can: PolicyDecider;
}

/** Deny-by-omission default: nothing is permitted until a gate is provided. */
export const DENY_ALL: PolicyGate = { can: () => false };

export const PolicyGateContext = createContext<PolicyGate>(DENY_ALL);

export function usePolicyGate(): PolicyGate {
  return useContext(PolicyGateContext);
}
