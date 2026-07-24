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
import { EvidenceBindingWorkbench } from "./EvidenceBindingWorkbench";

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
  // The provider-owned incarnation changes whenever the effective session or
  // tenant context changes. Never retain scope-bound rows across a missing or
  // changed incarnation; the backend remains the authorization authority.
  const authorityKey =
    session?.org_id && session.user_id && session.client_session_incarnation
      ? `${session.org_id}:${session.user_id}:${session.client_session_incarnation}`
      : undefined;

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

  const canRead = gate.can(COMPLIANCE_ACTIONS.read);
  // The backend permits this org-wide action to SUPER_ADMIN or an org-wide
  // custom grant. This is a conservative UI hint; the REST boundary remains
  // authoritative for every submission.
  const canWriteEvidence =
    (roles?.includes("SUPER_ADMIN") ?? false) ||
    (featureGrants?.includes(COMPLIANCE_ACTIONS.evidenceLink) ?? false);

  return (
    <PolicyGateProvider gate={gate}>
      <GenericModuleScreen config={complianceModuleScreen} api={api} authorityKey={authorityKey} />
      <EvidenceBindingWorkbench
        key={authorityKey ?? "no-authority"}
        api={api}
        authorityKey={authorityKey}
        canRead={canRead}
        canWrite={canWriteEvidence}
      />
    </PolicyGateProvider>
  );
}
