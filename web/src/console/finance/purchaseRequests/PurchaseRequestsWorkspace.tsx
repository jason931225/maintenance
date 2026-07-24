import type { ConsoleApiClient } from "../../../api/client";
import { PurchaseRequestPanel } from "../../../features/financial/PurchaseRequestPanel";

interface PurchaseRequestsWorkspaceProps {
  api: ConsoleApiClient;
  roles: readonly string[] | undefined;
}

/**
 * Console-finance composition boundary for the persisted purchase-request
 * lifecycle. The workflow itself stays in the financial feature boundary:
 * every list/detail/mutation uses the generated authenticated client, and it
 * owns its branch/session-incarnation abort and stale-response fences.
 */
export function PurchaseRequestsWorkspace({ api, roles }: PurchaseRequestsWorkspaceProps) {
  return (
    <section aria-label="구매요청 작업공간" className="px-6 pb-6">
      <PurchaseRequestPanel api={api} roles={roles} />
    </section>
  );
}
