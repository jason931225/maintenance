import type { ReactNode } from "react";

import {
  DENY_ALL,
  PolicyGateContext,
  usePolicyGate,
  type PolicyDecider,
  type PolicyGate,
  type PolicyResource,
} from "./PolicyGateContext";

export function PolicyGateProvider({
  gate,
  decide,
  children,
}: {
  gate?: PolicyGate;
  decide?: PolicyDecider;
  children: ReactNode;
}) {
  const value = gate ?? (decide ? { can: decide } : DENY_ALL);
  return (
    <PolicyGateContext.Provider value={value}>
      {children}
    </PolicyGateContext.Provider>
  );
}

/**
 * Deny-by-omission render gate for console affordances. Unauthorized controls are
 * absent, not disabled or explained.
 */
export function PolicyGated({
  action,
  resource,
  children,
  fallback = null,
}: {
  action: string;
  resource?: PolicyResource;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const gate = usePolicyGate();
  return <>{gate.can(action, resource) ? children : fallback}</>;
}
