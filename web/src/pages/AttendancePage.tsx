import { PageHeader } from "../components/shell/PageHeader";
import { AttendancePunchPanel } from "../features/attendance/AttendancePunchPanel";
import { ko } from "../i18n/ko";

/** Legacy standalone wrapper; ConsoleShell composes the panel into its route page. */
export function AttendancePage({ active = true }: { active?: boolean } = {}) {
  if (!active) return null;
  return (
    <>
      <PageHeader title={ko.attendance.title} description={ko.attendance.description} />
      <AttendancePunchPanel />
    </>
  );
}
