import { useEffect, useMemo, useState } from "react";

import { useAuth } from "../../context/auth";
import {
  fetchAuthzProjection,
  jwtFloorProjection,
  makePolicyGate,
  type AuthzProjection,
} from "../../console/policy/authz";
import { attendanceAuthorityKey } from "./attendanceAuthority";

/**
 * Attendance's route adapter consumes the console's canonical parsed authz
 * projection, and fails closed to the canonical JWT floor while loading.
 */
export function useAttendanceConsoleAuthz(active = true) {
  const { session } = useAuth();
  const floor = useMemo(() => jwtFloorProjection(session), [session]);
  const authorityKey = attendanceAuthorityKey(session);
  const token = session?.access_token;
  const [authoritative, setAuthoritative] = useState<{
    authorityKey: string | undefined;
    projection: AuthzProjection;
  }>();
  const projection =
    active && authoritative && authoritative.authorityKey === authorityKey
      ? authoritative.projection
      : floor;

  useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    void fetchAuthzProjection(token, controller.signal).then((next) => {
      if (!controller.signal.aborted && next)
        setAuthoritative({ authorityKey, projection: next });
    });
    return () => {
      controller.abort();
    };
  }, [active, authorityKey, token]);

  return useMemo(
    () => makePolicyGate(projection, projection.source === "authz"),
    [projection],
  );
}
