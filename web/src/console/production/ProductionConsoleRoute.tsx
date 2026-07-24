import { useAuth } from "../../context/auth";
import { ProductionScreen } from "./ProductionScreen";
import { deriveProductionCapabilities } from "./productionCapabilities";
import { useProductionConsoleAuthz } from "./useProductionConsoleAuthz";

/**
 * Module-owned route/body adapter. It consumes the console policy authz
 * projection, while shared registration remains intentionally outside this module.
 */
export function ProductionConsoleRoute({ branchId }: { branchId: string }) {
  return <ProductionConsoleBody branchId={branchId} />;
}

export function ProductionConsoleBody({ branchId }: { branchId: string }) {
  const { api, session } = useAuth();
  const authz = useProductionConsoleAuthz();
  const capabilities = deriveProductionCapabilities(authz, branchId);

  return (
    <ProductionScreen
      api={api}
      branchId={branchId}
      actorId={session?.user_id}
      capabilities={capabilities}
      sessionKey={session?.client_session_incarnation ?? session?.access_token}
    />
  );
}
