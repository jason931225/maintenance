import { useMemo } from "react";

import { useActiveBranchId, useAuth } from "../../context/auth";
import { equipmentStrings as text } from "../../i18n/equipment";
import { createEquipmentApi } from "./equipmentApi";
import { deriveEquipmentCapabilities } from "./equipmentCapabilities";
import { EquipmentScreen } from "./EquipmentScreen";
import { useEquipmentConsoleAuthz } from "./useEquipmentConsoleAuthz";

/**
 * Module-owned route/body adapter. It consumes the console policy authz
 * projection, while shared registration remains intentionally outside this
 * module (see the mount manifest in docs/evidence/console/CAP-EQUIPMENT-3R-PILOT).
 */
export function EquipmentConsoleRoute({ branchId }: { branchId: string }) {
  return <EquipmentConsoleBody branchId={branchId} />;
}

/** Prop-free adapter for the shared screen registry (`ComponentType` slot). */
export function EquipmentScreenBody() {
  const branchId = useActiveBranchId();
  if (!branchId) {
    return (
      <main className="equipment">
        <section className="equipment__panel" aria-labelledby="equipment-title">
          <h1 id="equipment-title">{text.title}</h1>
          <p role="status">{text.noBranch}</p>
        </section>
      </main>
    );
  }
  return <EquipmentConsoleBody branchId={branchId} />;
}

export function EquipmentConsoleBody({ branchId }: { branchId: string }) {
  const { session } = useAuth();
  const authz = useEquipmentConsoleAuthz();
  const capabilities = deriveEquipmentCapabilities(authz, branchId);
  const token = session?.access_token;
  const api = useMemo(() => createEquipmentApi(token), [token]);

  return (
    <EquipmentScreen
      api={api}
      branchId={branchId}
      actorId={session?.user_id}
      capabilities={capabilities}
      sessionKey={session?.client_session_incarnation ?? session?.access_token}
    />
  );
}
