import { useMemo, type ReactElement } from "react";

import { useActiveBranchId, useAuth } from "../../context/auth";
import { attendanceStrings as text } from "../../i18n/attendance";

import { AttendanceScreen } from "./AttendanceScreen";
import { SelfServiceAttendancePanel } from "./SelfServiceAttendancePanel";
import { deriveAttendanceCapabilities } from "./attendanceCapabilities";
import { createAttendanceApiTransport } from "./attendanceTransport";
import { createSelfServiceAttendanceTransport } from "./selfServiceAttendanceTransport";
import { useAttendanceConsoleAuthz } from "./useAttendanceConsoleAuthz";

/**
 * Registry-mountable, prop-less Attendance body. The authenticated console API
 * and active JWT branch are the sole transport/branch authority. A missing
 * branch is not replaced with an empty ID: there is no legal read or mutation
 * target; employee self-service remains available without selecting one.
 */
export function AttendanceScreenBody() {
  const { api, session } = useAuth();
  const branchId = useActiveBranchId();
  const ownTransport = useMemo(
    () => createSelfServiceAttendanceTransport(api),
    [api],
  );
  const sessionIdentity =
    session?.client_session_incarnation ?? session?.access_token;
  const selfServicePanel = (
    <SelfServiceAttendancePanel
      api={ownTransport}
      sessionIdentity={sessionIdentity}
      active={session !== undefined}
    />
  );

  if (branchId === undefined) {
    return (
      <main className="attendance" aria-label={text.title}>
        {selfServicePanel}
      </main>
    );
  }

  return (
    <AuthenticatedAttendanceBody
      api={api}
      branchId={branchId}
      session={session}
      selfServicePanel={selfServicePanel}
    />
  );
}

function AuthenticatedAttendanceBody({
  api,
  branchId,
  session,
  selfServicePanel,
}: {
  api: ReturnType<typeof useAuth>["api"];
  branchId: string;
  session: ReturnType<typeof useAuth>["session"];
  selfServicePanel: ReactElement;
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
      selfServicePanel={selfServicePanel}
    />
  );
}

/** Public module route uses the same prop-less authenticated body as the registry. */
export function AttendanceConsoleRoute() {
  return <AttendanceScreenBody />;
}
