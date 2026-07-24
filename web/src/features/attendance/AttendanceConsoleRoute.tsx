import { useActiveBranchId, useAuth } from "../../context/auth";

import { AttendanceScreen } from "./AttendanceScreen";
import { deriveAttendanceCapabilities } from "./attendanceCapabilities";
import type { AttendanceTransport } from "./attendanceApi";
import { useAttendanceConsoleAuthz } from "./useAttendanceConsoleAuthz";

/**
 * Module-owned body adapter. Shared router/generated-client integration supplies
 * the authenticated Attendance transport explicitly; this leaf never guesses
 * at missing generated paths or falls back to an untyped client.
 */
export function AttendanceConsoleRoute({
  branchId,
  transport,
}: {
  branchId: string;
  transport: AttendanceTransport;
}) {
  return <AttendanceConsoleBody branchId={branchId} transport={transport} />;
}

export function AttendanceConsoleBody({
  branchId,
  transport,
}: {
  branchId: string;
  transport: AttendanceTransport;
}) {
  const { session } = useAuth();
  const authz = useAttendanceConsoleAuthz();
  const capabilities = deriveAttendanceCapabilities(authz, branchId);

  return (
    <AttendanceScreen
      transport={transport}
      branchId={branchId}
      actorId={session?.user_id}
      capabilities={capabilities}
      sessionKey={session?.client_session_incarnation ?? session?.access_token}
    />
  );
}

/**
 * Shared registry adapter. Its caller owns the generated-client binding and
 * provides the current active branch; a missing transport cannot be masked.
 */
export function AttendanceScreenBody({
  transport,
}: {
  transport: AttendanceTransport;
}) {
  const branchId = useActiveBranchId();
  return <AttendanceConsoleBody branchId={branchId ?? ""} transport={transport} />;
}
