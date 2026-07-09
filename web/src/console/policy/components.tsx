// Carbon-copy console policy gate — components (see ./context for the interface).

import { type ReactNode } from "react";

import { PolicyContext, type PolicyDecider, usePolicyGate } from "./context";

export function PolicyProvider({
  decide,
  children,
}: {
  decide: PolicyDecider;
  children: ReactNode;
}) {
  return <PolicyContext.Provider value={decide}>{children}</PolicyContext.Provider>;
}

/**
 * Renders `children` only when policy allows the action, else `fallback`
 * (default: nothing). Deny-by-omission — a denied affordance leaves no trace in
 * the DOM, so a persona that cannot act never sees a disabled ghost of the CTA.
 */
export function PolicyGated({
  action,
  resource,
  children,
  fallback = null,
}: {
  action: string;
  resource?: string;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const decide = usePolicyGate();
  return <>{decide({ action, resource }) ? children : fallback}</>;
}
