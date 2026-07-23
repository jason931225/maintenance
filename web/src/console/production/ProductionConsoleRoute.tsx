import { useMemo } from "react";

import { useAuth } from "../../context/auth";
import { usePolicyGate } from "../policy/PolicyGate";
import { ProductionScreen } from "./ProductionScreen";
import { deriveProductionCapabilities, type EffectiveCapabilityProjection } from "./productionCapabilities";

/**
 * Module-owned shell adapter. The shell supplies a branch and its shared,
 * advisory effective-capability projection; this module never derives controls
 * from role names. Backend authorization remains the authority for every call.
 */
export function ProductionConsoleRoute({
  branchId,
  capabilityProjection,
}: {
  branchId: string;
  capabilityProjection?: EffectiveCapabilityProjection;
}) {
  const { session } = useAuth();
  const sharedGate = usePolicyGate();
  const projection = capabilityProjection ?? sharedGate;
  const capabilities = useMemo(
    () => deriveProductionCapabilities(projection, branchId),
    [branchId, projection],
  );

  return (
    <ProductionScreen
      branchId={branchId}
      actorId={session?.user_id}
      capabilities={capabilities}
      sessionKey={session?.client_session_incarnation ?? session?.access_token}
    />
  );
}
