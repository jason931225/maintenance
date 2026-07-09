import { type ReactNode } from "react";

import {
  DENY_ALL,
  PolicyGateContext,
  usePolicyGate,
  type PolicyDecider,
  type PolicyGate,
  type PolicyResource,
} from "./usePolicyGate";

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
  return <PolicyGateContext.Provider value={value}>{children}</PolicyGateContext.Provider>;
}

/**
 * Renders its children only when the current gate permits `action` on
 * `resource`; otherwise renders nothing (deny-by-omission — never a disabled or
 * greyed affordance).
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
