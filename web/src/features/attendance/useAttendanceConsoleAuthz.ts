import { useEffect, useMemo, useState } from "react";

import { useAuth } from "../../context/auth";
import {
  fetchAuthzProjection,
  jwtFloorProjection,
  makePolicyGate,
  type AuthzProjection,
} from "../../console/policy/authz";

/**
 * Attendance's route adapter consumes the console's canonical parsed authz
 * projection, and fails closed to the canonical JWT floor while loading.
 */
export function useAttendanceConsoleAuthz(active = true) {
  const { session } = useAuth();
  const floor = useMemo(() => jwtFloorProjection(session), [session]);
  const sessionIdentity =
    session?.client_session_incarnation ?? session?.access_token;
  const token = session?.access_token;
  const [authoritative, setAuthoritative] = useState<{
    sessionIdentity: string | undefined;
    projection: AuthzProjection;
  }>();
  const projection =
    active && authoritative && authoritative.sessionIdentity === sessionIdentity
      ? authoritative.projection
      : floor;

  useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    void fetchAuthzProjection(token, controller.signal).then((next) => {
      if (!controller.signal.aborted && next)
        setAuthoritative({ sessionIdentity, projection: next });
    });
    return () => {
      controller.abort();
    };
    // The effective session identity owns this request's lifetime. A token
    // refresh within the same incarnation must not replace its cache key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionIdentity]);

  return useMemo(
    () => makePolicyGate(projection, projection.source === "authz"),
    [projection],
  );
}
