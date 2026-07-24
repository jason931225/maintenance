import { useMemo, type ReactElement } from "react";

import { useActiveBranchId, useAuth } from "../../context/auth";
import { PageHeader } from "../../components/shell/PageHeader";
import { attendanceStrings as text } from "../../i18n/attendance";
import { ko } from "../../i18n/ko";
import { AttendancePunchPanel } from "./AttendancePunchPanel";

import { AttendanceScreen } from "./AttendanceScreen";
import { SelfServiceAttendancePanel } from "./SelfServiceAttendancePanel";
import { attendanceAuthorityKey } from "./attendanceAuthority";
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
export function AttendanceScreenBody({ active = true }: { active?: boolean }) {
  const { api, session } = useAuth();
  const branchId = useActiveBranchId();
  const ownTransport = useMemo(
    () => createSelfServiceAttendanceTransport(api),
    [api],
  );
  const sessionIdentity = attendanceAuthorityKey(session);
  const selfServicePanel = (
    <SelfServiceAttendancePanel
      api={ownTransport}
      sessionIdentity={sessionIdentity}
      active={active && session !== undefined}
    />
  );

  if (!active) return null;

  const personalAttendance = (
    <section className="grid gap-5" aria-labelledby="attendance-personal-area-heading">
      <h2 id="attendance-personal-area-heading" className="text-xl font-semibold text-ink">
        {text.personal.title}
      </h2>
      <AttendancePunchPanel active={active} />
      {selfServicePanel}
    </section>
  );

  if (branchId === undefined) {
    return (
      <section className="attendance" aria-label={text.title}>
        <PageHeader title={ko.attendance.title} description={ko.attendance.description} />
        {personalAttendance}
      </section>
    );
  }

  return (
    <AuthenticatedAttendanceBody
      api={api}
      branchId={branchId}
      session={session}
      personalAttendance={personalAttendance}
      active={active}
    />
  );
}

function AuthenticatedAttendanceBody({
  api,
  branchId,
  session,
  personalAttendance,
  active,
}: {
  api: ReturnType<typeof useAuth>["api"];
  branchId: string;
  session: ReturnType<typeof useAuth>["session"];
  personalAttendance: ReactElement;
  active: boolean;
}) {
  const authz = useAttendanceConsoleAuthz(active);
  const capabilities = deriveAttendanceCapabilities(authz, branchId);
  const transport = useMemo(
    () => createAttendanceApiTransport(api, branchId),
    [api, branchId],
  );

  return (
    <section className="attendance" aria-label={text.title}>
      <PageHeader title={ko.attendance.title} description={ko.attendance.description} />
      <AttendanceScreen
        transport={transport}
        branchId={branchId}
        actorId={session?.user_id}
        capabilities={capabilities}
        sessionKey={attendanceAuthorityKey(session)}
        active={active}
      />
      {personalAttendance}
    </section>
  );
}

/** Public module route uses the same prop-less authenticated body as the registry. */
