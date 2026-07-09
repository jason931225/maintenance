import { type ReactNode } from "react";

import { PolicyGateContext, usePolicyGate, type PolicyDecider } from "./usePolicyGate";

/** Provides the active policy decider to a subtree (see usePolicyGate.ts). */
export function PolicyGateProvider({
  decide,
  children,
}: {
  decide: PolicyDecider;
  children: ReactNode;
}) {
  return <PolicyGateContext.Provider value={decide}>{children}</PolicyGateContext.Provider>;
}

export interface PolicyGatedProps {
  /** Feature/permission key the affordance requires (e.g. "work_order.reject"). */
  action: string;
  children: ReactNode;
}

/**
 * Renders `children` only when the active decider permits `action`; otherwise
 * renders nothing (deny-by-omission — no placeholder, no disabled control).
 */
export function PolicyGated({ action, children }: PolicyGatedProps) {
  const decide = usePolicyGate();
  return decide(action) ? <>{children}</> : null;
}
