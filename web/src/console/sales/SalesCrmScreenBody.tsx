import { useMemo } from "react";

import { useAuth } from "../../context/auth";
import { useConsoleAuthz } from "../shell/authz";
import { SalesCrmScreen } from "./SalesCrmScreen";
import { canAccessSales } from "./salesAccess";

/** Registry-ready adapter. Backend authorization remains the authority. */
export function SalesCrmScreenBody() {
  const { api } = useAuth();
  const { grants } = useConsoleAuthz();
  const allowed = useMemo(() => canAccessSales(grants.roles, grants.featureGrants), [grants]);
  return allowed ? <SalesCrmScreen api={api} /> : null;
}
