import { useAuth } from "../../context/auth";
import { ProductionScreen } from "./ProductionScreen";

/**
 * Console mount contract: the shell supplies its selected branch scope, while
 * action availability is derived only from the authenticated session.
 */
export function ProductionConsoleRoute({ branchId }: { branchId: string }) {
  const { session } = useAuth();
  return <ProductionScreen branchId={branchId} roles={session?.roles ?? []} />;
}
