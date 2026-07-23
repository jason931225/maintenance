// 결재 상신 screen body — the SCREEN_REGISTRY mount for the "appr" nav slot.
// ApprovalCompose already drives the REAL workflow-run/approval REST surface
// (POST /api/v1/workflow-runs, /api/v1/workflow-tasks/{id}/decide|finalize,
// GET /api/v1/workflow-studio/submittable-definitions) through composeApi; this
// body only binds the session (bearer token + current user) and the same
// role-based policy gate the legacy /modules?screen=appr mount used
// (ConsoleModuleRoute.apprGate), so both entry points authorize identically.
// Prop-less by SCREEN_REGISTRY contract; deny-by-omission for unauthorized.
import { useMemo } from "react";

import { useAuth } from "../../context/auth";
import { PolicyGateProvider, type PolicyGate } from "../policy";
import { ApprovalBulkInbox } from "./ApprovalBulkInbox";
import { ApprovalCompose } from "./ApprovalCompose";

// The five granted operational roles plus MEMBER — everyone signed in can raise
// an approval (mirrors ConsoleModuleRoute.APPR_ROLES). The backend re-authorizes
// every workflow mutation and enforces SoD on each call.
const APPR_ROLES = new Set([
  "SUPER_ADMIN",
  "ADMIN",
  "EXECUTIVE",
  "MECHANIC",
  "RECEPTIONIST",
  "MEMBER",
]);

export function ApprovalScreenBody() {
  const { session } = useAuth();
  const roles = session?.roles;
  const featureGrants = session?.feature_grants;

  const gate = useMemo<PolicyGate>(
    () => ({
      can: (action) => {
        if (featureGrants?.includes(action)) return true;
        if (action.startsWith("appr.")) {
          return roles?.some((role) => APPR_ROLES.has(role)) ?? false;
        }
        return false;
      },
    }),
    [featureGrants, roles],
  );

  return (
    <PolicyGateProvider gate={gate}>
      <ApprovalBulkInbox
        bearerToken={session?.access_token}
        currentUserId={session?.user_id}
        currentOrgId={session?.org_id}
        clientSessionIncarnation={session?.client_session_incarnation}
      />
      <ApprovalCompose bearerToken={session?.access_token} currentUserId={session?.user_id} />
    </PolicyGateProvider>
  );
}
