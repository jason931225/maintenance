import { useMemo } from "react";

import { useAuth } from "../../context/auth";
import { SalesCrmScreen } from "./SalesCrmScreen";
import { canAccessSales } from "./salesAccess";

/** Registry-ready adapter. Backend authorization remains the authority. */
export function SalesCrmScreenBody() {
  const { api, session } = useAuth();
  const allowed = useMemo(() => canAccessSales(session?.roles, session?.feature_grants), [session?.feature_grants, session?.roles]);
  return allowed ? <SalesCrmScreen api={api} /> : null;
}
