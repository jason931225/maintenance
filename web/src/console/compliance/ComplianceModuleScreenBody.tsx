// 준법·의무 screen body — the SCREEN_REGISTRY mount for the "compliance" nav
// slot. The real surface (CP-/RG-/FW- catalog list, status/risk chips, FSM
// next-states, control→evidence coverage ledger) lives in GenericModuleScreen +
// complianceModuleScreen; this body binds the authenticated api client AND the
// policy gate, same idiom as ModuleFinanceScreenBody.
//
// Gate mirrors the nav gate for this slot (g(INTEGRITY_ROLES,
// [INTEGRITY_FINDINGS_READ])): EXECUTIVE/SUPER_ADMIN read the catalog, and a
// holder of the integrity-findings feature grant reads it too. Every other role
// is denied by omission (blank — the intended state for the unauthorized). The
// backend re-authorizes and RLS-scopes every compliance read.
import { useMemo } from "react";

import { useAuth } from "../../context/auth";
import { GenericModuleScreen } from "../modules/GenericModuleScreen";
import { PolicyGateProvider, type PolicyGate } from "../policy";
import { COMPLIANCE_ACTIONS } from "./complianceModel";
import { complianceModuleScreen } from "./complianceModuleScreen";

const COMPLIANCE_READ_ROLES = new Set(["EXECUTIVE", "SUPER_ADMIN"]);
const INTEGRITY_FINDINGS_READ = "integrity_findings_read";
const READ_ACTIONS = new Set<string>([
  COMPLIANCE_ACTIONS.read,
  COMPLIANCE_ACTIONS.regulationRead,
  COMPLIANCE_ACTIONS.frameworkRead,
  COMPLIANCE_ACTIONS.audit,
]);

export function ComplianceModuleScreenBody() {
  const { api, session } = useAuth();
  const roles = session?.roles;
  const featureGrants = session?.feature_grants;

  const gate = useMemo<PolicyGate>(
    () => ({
      can: (action) => {
        if (featureGrants?.includes(action)) return true;
        if (READ_ACTIONS.has(action)) {
          return (
            (roles?.some((role) => COMPLIANCE_READ_ROLES.has(role)) ?? false) ||
            (featureGrants?.includes(INTEGRITY_FINDINGS_READ) ?? false)
          );
        }
        return false;
      },
    }),
    [featureGrants, roles],
  );

  return (
    <PolicyGateProvider gate={gate}>
      <GenericModuleScreen config={complianceModuleScreen} api={api} />
    </PolicyGateProvider>
  );
}
