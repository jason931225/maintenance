import { PageHeader } from "../components/shell/PageHeader";
import { LeaveBody } from "../console/screens/leave/LeaveBody";
import { leaveManagementKo as copy } from "../i18n/hrWorkflows";

/**
 * Legacy `/hr/leave-management` route adapter.
 *
 * The authoritative leave/persona implementation lives in `LeaveBody`; keeping
 * a second fetch/gate/mutation stack here previously diverged from the console
 * route and could not consume the self-service or exact-charge contracts.
 */
export function LeaveManagementPage() {
  return (
    <>
      <PageHeader title={copy.title} />
      <div className="grid max-w-7xl gap-5">
        <LeaveBody />
      </div>
    </>
  );
}
