// Carbon-copy console policy gate — adapter components for query-shaped callers.

import { useMemo, type ReactNode } from "react";

import { PolicyGateContext, type PolicyGate, type PolicyResource } from "./usePolicyGate";

/** A policy question: an action verb, optionally about a specific resource. */
export interface PolicyQuery {
  action: string;
  resource?: string;
}

/** Returns true iff the current principal may perform the queried action. */
export type PolicyQueryDecider = (query: PolicyQuery) => boolean;

function resourceKey(resource?: PolicyResource): string | undefined {
  if (!resource) return undefined;
  return typeof resource === "string" ? resource : `${resource.kind}:${resource.id}`;
}

export function PolicyProvider({
  decide,
  children,
}: {
  decide: PolicyQueryDecider;
  children: ReactNode;
}) {
  const gate = useMemo<PolicyGate>(
    () => ({
      can: (action, resource) => decide({ action, resource: resourceKey(resource) }),
    }),
    [decide],
  );

  return <PolicyGateContext.Provider value={gate}>{children}</PolicyGateContext.Provider>;
}
