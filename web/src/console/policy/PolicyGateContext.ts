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

export const PolicyGateContext = createContext<PolicyGate>(DENY_ALL);

export function usePolicyGate(): PolicyGate {
  return useContext(PolicyGateContext);
}
