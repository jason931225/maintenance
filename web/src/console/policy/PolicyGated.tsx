import { type ReactNode } from "react";

import {
  PolicyGateContext,
  usePolicyGate,
  type PolicyGate,
  type PolicyResource,
} from "./usePolicyGate";

export function PolicyGateProvider({
  gate,
  children,
}: {
  gate: PolicyGate;
  children: ReactNode;
}) {
  return <PolicyGateContext.Provider value={gate}>{children}</PolicyGateContext.Provider>;
}

/**
 * Renders its children only when the current gate permits `action` on
 * `resource`; otherwise renders nothing (deny-by-omission — never a disabled or
 * greyed affordance, §4.5).
 */
export function PolicyGated({
  action,
  resource,
  children,
}: {
  action: string;
  resource?: PolicyResource;
  children: ReactNode;
}) {
  const gate = usePolicyGate();
  return gate.can(action, resource) ? <>{children}</> : null;
}
