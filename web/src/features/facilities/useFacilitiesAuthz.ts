import { useEffect, useMemo, useState } from "react";

import { useAuth } from "../../context/auth";
import {
  fetchAuthzProjection,
  jwtFloorProjection,
  makePolicyGate,
  type AuthzProjection,
} from "../../console/policy/authz";

/**
 * Facilities consumes the console's one authoritative `/api/v1/me/authz`
 * projection. Until that response arrives, the thinner JWT floor denies by
 * omission rather than inferring capability from a session role.
 */
export function useFacilitiesAuthz() {
  const { session } = useAuth();
  const token = session?.access_token;
  const floor = useMemo(() => jwtFloorProjection(session), [session]);
  const [authoritative, setAuthoritative] = useState<{
    token: string | undefined;
    projection: AuthzProjection;
  }>();
  const projection = authoritative && authoritative.token === token
    ? authoritative.projection
    : floor;

  useEffect(() => {
    const controller = new AbortController();
    void fetchAuthzProjection(token, controller.signal).then((next) => {
      if (!controller.signal.aborted && next) {
        setAuthoritative({ token, projection: next });
      }
    });
    return () => { controller.abort(); };
  }, [token]);

  return useMemo(() => makePolicyGate(projection, projection.source === "authz"), [projection]);
}
