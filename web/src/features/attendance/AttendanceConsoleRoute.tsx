import { useAuth, useActiveBranchId } from "../../context/auth";
import { AttendanceScreen } from "./AttendanceScreen";
import { deriveAttendanceCapabilities } from "./attendanceCapabilities";
import { useAttendanceConsoleAuthz } from "./useAttendanceConsoleAuthz";

/**
 * Module-owned route/body adapter. It consumes the console policy authz
 * projection, while shared registration remains intentionally outside this module.
 */
export function AttendanceConsoleRoute({ branchId }: { branchId: string }) {
  return <AttendanceConsoleBody branchId={branchId} />;
}

export function AttendanceConsoleBody({ branchId }: { branchId: string }) {
  const { api, session } = useAuth();
  const authz = useAttendanceConsoleAuthz();
  const capabilities = deriveAttendanceCapabilities(authz, branchId);

  return (
    <AttendanceScreen
      api={api}
      branchId={branchId}
      actorId={session?.user_id}
      capabilities={capabilities}
      sessionKey={session?.client_session_incarnation ?? session?.access_token}
    />
  );
}

/**
 * Propless registry body (SCREEN_REGISTRY mounts bodies without props). The
 * active branch comes from the JWT `branches` claim; without one the screen
 * renders its truthful denied state via fail-closed capabilities.
 */
export function AttendanceScreenBody() {
  const branchId = useActiveBranchId();
  return <AttendanceConsoleBody branchId={branchId ?? ""} />;
}
