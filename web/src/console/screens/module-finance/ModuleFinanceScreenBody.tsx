// 재무 screen — composition only. The real surface (stat strip, voucher
// ledger table with state chips, journal-entry object card, DOCUMENT FLOW chip
// chain, 승인 상신/승인/전기/반제 actions) already lives in
// GenericModuleScreen + financeModuleScreen (console/modules/*, console/finance/*);
// this body binds the real authenticated api client AND the policy gate.
//
// R4 blank-plane fix: the ConsoleShell mounts screen bodies with NO ambient
// policy provider, so `usePolicyGate()` fell through to the DENY_ALL default —
// and GenericModuleScreen gates its ENTIRE surface on `config.policy.read`, so
// the whole content plane rendered nothing (only the topbar). Cedar's
// bulk-authorize is shadow-only today (legacy RBAC is the sole enforcer), so a
// BulkPolicyGateProvider would deny every action too. Gate on the same
// role/feature model the nav + the legacy ConsoleModuleRoute already use:
// management roles read the ledger, feature grants unlock the writes, every
// other role is denied by omission (blank — as intended for the unauthorized).
import { useMemo } from "react";

import { useAuth } from "../../../context/auth";
import { GenericModuleScreen } from "../../modules/GenericModuleScreen";
import { financeModuleScreen } from "../../modules/moduleScreens";
import { PolicyGateProvider, type PolicyGate } from "../../policy";

// Read tier for module surfaces — mirrors ConsoleModuleRoute's MODULE_READ_ROLES
// (the legacy /modules mount of this same screen), so both entry points agree.
const MODULE_READ_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "EXECUTIVE", "MECHANIC", "RECEPTIONIST"]);

export function ModuleFinanceScreenBody() {
  const { api, session } = useAuth();
  const roles = session?.roles;
  const featureGrants = session?.feature_grants;

  const gate = useMemo<PolicyGate>(
    () => ({
      can: (action) => {
        if (featureGrants?.includes(action)) return true;
        if (action === financeModuleScreen.policy.read) {
          return roles?.some((role) => MODULE_READ_ROLES.has(role)) ?? false;
        }
        return false;
      },
    }),
    [featureGrants, roles],
  );

  return (
    <PolicyGateProvider gate={gate}>
      <GenericModuleScreen config={financeModuleScreen} api={api} />
    </PolicyGateProvider>
  );
}
