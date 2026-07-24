import { useMemo } from "react";

import { useActiveBranchId, useAuth } from "../../context/auth";
import { attendanceStrings as text } from "../../i18n/attendance";

import { AttendanceScreen } from "./AttendanceScreen";
import { deriveAttendanceCapabilities } from "./attendanceCapabilities";
import { createAttendanceApiTransport } from "./attendanceTransport";
import { useAttendanceConsoleAuthz } from "./useAttendanceConsoleAuthz";

/**
 * Registry-mountable, prop-less Attendance body. The authenticated console API
 * and active JWT branch are the sole transport/branch authority. A missing
 * branch is not replaced with an empty ID: there is no legal read or mutation
 * target, so the body reports that state explicitly.
 */
export function AttendanceScreenBody() {
  const { api, session } = useAuth();
  const branchId = useActiveBranchId();

  if (branchId === undefined) {
    return (
      <section className="attendance" aria-label={text.title}>
        <div className="attendance__panel">
          <h1>{text.title}</h1>
          <p role="status">{text.noBranch}</p>
        </div>
      </section>
    );
  }

  return <AuthenticatedAttendanceBody api={api} branchId={branchId} session={session} />;
}

function AuthenticatedAttendanceBody({
  api,
  branchId,
  session,
}: {
  api: ReturnType<typeof useAuth>["api"];
  branchId: string;
  session: ReturnType<typeof useAuth>["session"];
}) {
  const authz = useAttendanceConsoleAuthz();
  const capabilities = deriveAttendanceCapabilities(authz, branchId);
  const transport = useMemo(
    () => createAttendanceApiTransport(api, branchId),
    [api, branchId],
  );

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

/** Public module route uses the same prop-less authenticated body as the registry. */
export function AttendanceConsoleRoute() {
  return <AttendanceScreenBody />;
}
