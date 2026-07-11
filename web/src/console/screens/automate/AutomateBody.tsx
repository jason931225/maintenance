// Console screen composition for the automate surface (nav 워크플로 스튜디오 —
// no single 자동화 hub owns the whole nav item, this screen IS the studio).
// §4-18: reuses the SAME AutomateHub the legacy /automate route mounts
// (AutomatePage.tsx) — rule list (활성/중지 chips + run count), the
// trigger→condition→action flow builder (console/canvas BlockCanvas, the
// canonical graph builder), 실행 이력, and the §3.9.0 version-pending banner
// (개정대기/적용승인/철회) all live in AutomateHub already, wired to the real
// workflow-studio REST. This file only supplies the console-grammar mount
// point (the policy gate) — no new UI, per the composition mandate.
//
// R4 empty-surface fix: the hub gates its tabs on `console.automate.tab.*.view`
// resolved through Cedar bulk-authorize, but Cedar is shadow-only today (legacy
// RBAC is the sole enforcer), so EVERY automate action denied — even for
// SUPER_ADMIN — and the tab row collapsed to "접근 가능한 탭 없음". The console
// nav already gates this surface on SUPER_ADMIN (ROLE_MANAGE_ROLES); gate on
// that same real enforcer instead of the empty Cedar lane: SUPER_ADMIN holds
// every automate capability, feature grants unlock individual actions for other
// roles, and everyone else is denied by omission (no tabs).
import { useMemo } from "react";

import { useAuth } from "../../../context/auth";
import { AutomateHub, AUTOMATE_GATE_ACTIONS } from "../../../pages/AutomatePage";
import { PolicyGateProvider, type PolicyGate } from "../../policy";

// System-tier surface — mirrors the nav's ROLE_MANAGE_ROLES gate on "workflow".
const AUTOMATE_MANAGE_ROLES = new Set(["SUPER_ADMIN"]);
const AUTOMATE_ACTION_SET = new Set<string>(AUTOMATE_GATE_ACTIONS);

export function AutomateBody() {
  const { session } = useAuth();
  const roles = session?.roles;
  const featureGrants = session?.feature_grants;

  const gate = useMemo<PolicyGate>(
    () => ({
      can: (action) => {
        if (featureGrants?.includes(action)) return true;
        if (AUTOMATE_ACTION_SET.has(action)) {
          return roles?.some((role) => AUTOMATE_MANAGE_ROLES.has(role)) ?? false;
        }
        return false;
      },
    }),
    [featureGrants, roles],
  );

  return (
    <PolicyGateProvider gate={gate}>
      <AutomateHub />
    </PolicyGateProvider>
  );
}
