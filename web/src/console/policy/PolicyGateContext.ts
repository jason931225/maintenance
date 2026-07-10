import { createContext, useContext } from "react";

export type PolicyResource =
  | string
  | {
      kind?: string;
      id?: string;
      scope?: string;
    };

export interface PolicyGate {
  can: (action: string, resource?: PolicyResource) => boolean;
}

export type PolicyDecider = PolicyGate["can"];

export const DENY_ALL: PolicyGate = {
  can: () => false,
};

/**
 * Build a deny-by-omission gate from resolved bulk-authorize decisions. The gate
 * keys on `action` (resource is contextual, mirroring the allow-list gates this
 * replaces): an action absent from the map — pending, denied, or never
 * requested — is denied. Never optimistic.
 */
export function decisionGate(decisions: ReadonlyMap<string, boolean>): PolicyGate {
  return { can: (action) => decisions.get(action) === true };
}

export const PolicyGateContext = createContext<PolicyGate>(DENY_ALL);

export function usePolicyGate(): PolicyGate {
  return useContext(PolicyGateContext);
}
