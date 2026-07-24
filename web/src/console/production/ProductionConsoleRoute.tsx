import { useAuth } from "../../context/auth";
import { useConsoleAuthz } from "../shell/authz";
import { ProductionScreen } from "./ProductionScreen";
import { deriveProductionCapabilities } from "./productionCapabilities";

/**
 * Module-owned route/body adapter. It consumes the console's canonical authz
 * source, while shared registration remains intentionally outside this module.
 */
export function ProductionConsoleRoute({ branchId }: { branchId: string }) {
  return <ProductionConsoleBody branchId={branchId} />;
}

export function ProductionConsoleBody({ branchId }: { branchId: string }) {
  const { api, session } = useAuth();
  const { grants } = useConsoleAuthz();
  const capabilities = deriveProductionCapabilities(grants);

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
