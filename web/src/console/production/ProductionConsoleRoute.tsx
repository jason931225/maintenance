import { useAuth } from "../../context/auth";
import { ProductionScreen } from "./ProductionScreen";
import {
  deriveProductionCapabilities,
  type EffectiveCapabilityProjection,
} from "./productionCapabilities";

/**
 * Module-owned shell adapter. Its caller must supply the shared effective
 * capability projection; unavailable authority is a mount error, not a local
 * deny-all fallback. Backend authorization remains the authority for every call.
 */
export function ProductionConsoleRoute({
  branchId,
  capabilityProjection,
}: {
  branchId: string;
  capabilityProjection: EffectiveCapabilityProjection;
}) {
  const { session } = useAuth();
  const capabilities = deriveProductionCapabilities(capabilityProjection, branchId);

  return (
    <ProductionScreen
      branchId={branchId}
      actorId={session?.user_id}
      capabilities={capabilities}
      sessionKey={session?.client_session_incarnation ?? session?.access_token}
    />
  );
}
