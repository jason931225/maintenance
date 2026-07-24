import type { ConsoleApiClient } from "../../../api/client";
import { PurchaseRequestPanel } from "../../../features/financial/PurchaseRequestPanel";
import { ko } from "../../../i18n/ko";

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
    <section aria-label={ko.financial.purchase.workspaceAria} className="purchase-requests-workspace">
      <PurchaseRequestPanel api={api} roles={roles} />
    </section>
  );
}
