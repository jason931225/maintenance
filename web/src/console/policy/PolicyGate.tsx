import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { useAuth } from "../../context/auth";
import {
  DENY_ALL_PROJECTION,
  fetchAuthzProjection,
  jwtFloorProjection,
  makePolicyGate,
  type AuthzProjection,
  type PolicyGate,
  type PolicyQuery,
} from "./authz";

/**
 * PolicyGated / usePolicyGate — THE single render-gating primitive for the
 * console. Every rendered affordance routes through it: children (or the
 * imperative `allows`) appear only when the caller holds the capability
 * (deny-by-omission — never a disabled-ghost affordance).
 *
 * Contract (stable across the Cedar promotion flip): the gate reads
 * `GET /api/v1/me/authz` (authoritative, `advisory_ui_only`) and falls back to
 * a fail-closed JWT floor on error. The Cedar flip retargets the *endpoint's*
 * `source` server-side; this interface does not change. See {@link ./authz}.
 */

/** Fail-closed default: denies everything when no provider is mounted. */
const DENY_ALL_GATE: PolicyGate = makePolicyGate(DENY_ALL_PROJECTION, false);

export const PolicyGateContext = createContext<PolicyGate>(DENY_ALL_GATE);

/** Logic-side gating: `usePolicyGate().allows({ feature, branch })`. */
export function usePolicyGate(): PolicyGate {
  return useContext(PolicyGateContext);
}

export function PolicyGateProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const token = session?.access_token;
  const floor = useMemo(() => jwtFloorProjection(session), [session]);
  const [authoritative, setAuthoritative] = useState<
    { token: string | undefined; projection: AuthzProjection } | undefined
  >();
  const current =
    authoritative && authoritative.token === token ? authoritative.projection : undefined;

  useEffect(() => {
    const controller = new AbortController();
    void fetchAuthzProjection(token, controller.signal).then((projection) => {
      if (!controller.signal.aborted && projection) setAuthoritative({ token, projection });
    });
    return () => {
      controller.abort();
    };
  }, [token]);

  const gate = useMemo(
    () => (current ? makePolicyGate(current, true) : makePolicyGate(floor, false)),
    [current, floor],
  );

  return <PolicyGateContext.Provider value={gate}>{children}</PolicyGateContext.Provider>;
}

export function PolicyGated({
  feature,
  branch,
  minPermission,
  children,
  fallback = null,
}: PolicyQuery & { children: ReactNode; fallback?: ReactNode }) {
  const gate = usePolicyGate();
  return <>{gate.allows({ feature, branch, minPermission }) ? children : fallback}</>;
}
