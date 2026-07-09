import { createContext, useContext } from "react";

/**
 * Shared action/resource policy-gate primitive for object-card and lifecycle
 * affordances. Deny-by-omission: without an explicit provider, nothing renders.
 */
export type PolicyResource =
  | string
  | {
      kind: string;
      id: string;
    };

/** Returns whether `action` on the optional resource is permitted. */
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
