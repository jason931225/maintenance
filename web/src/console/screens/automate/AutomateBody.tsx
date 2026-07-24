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
import { useCallback, useEffect, useMemo } from "react";
import { useLocation, useNavigate } from "react-router";

import { useAuth } from "../../../context/auth";
import {
  AutomateHub,
  AUTOMATE_GATE_ACTIONS,
  type AutomateTab,
} from "../../../pages/AutomatePage";
import { PolicyGateProvider, type PolicyGate } from "../../policy";

// System-tier surface — mirrors the nav's ROLE_MANAGE_ROLES gate on "workflow".
const AUTOMATE_MANAGE_ROLES = new Set(["SUPER_ADMIN"]);
const AUTOMATE_ACTION_SET = new Set<string>(AUTOMATE_GATE_ACTIONS);

export function AutomateBody() {
  const { session } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const roles = session?.roles;
  const featureGrants = session?.feature_grants;
  const routeSearch = new URLSearchParams(location.search);
  const requestedTab = routeSearch.get("tab");
  const routeTab: AutomateTab =
    location.pathname === "/console/scheduled"
      ? "schedules"
      : requestedTab === "monitors"
        ? "monitors"
        : "rules";

  if (location.pathname === "/console/scheduled" || requestedTab !== "monitors") {
    routeSearch.delete("tab");
  } else {
    routeSearch.set("tab", "monitors");
  }
  const canonicalQuery = routeSearch.toString();
  const canonicalSearch = canonicalQuery ? `?${canonicalQuery}` : "";

  useEffect(() => {
    if (canonicalSearch !== location.search) {
      void navigate(
        { pathname: location.pathname, search: canonicalSearch, hash: location.hash },
        { replace: true },
      );
    }
  }, [canonicalSearch, location.hash, location.pathname, location.search, navigate]);

  const navigateToTab = useCallback(
    (tab: AutomateTab) => {
      const search = new URLSearchParams(location.search);
      if (tab === "monitors") search.set("tab", "monitors");
      else search.delete("tab");
      const query = search.toString();
      const target = {
        pathname: tab === "schedules" ? "/console/scheduled" : "/console/workflow",
        search: query ? `?${query}` : "",
        hash: location.hash,
      };
      if (
        target.pathname !== location.pathname ||
        target.search !== location.search ||
        target.hash !== location.hash
      ) {
        void navigate(target);
      }
    },
    [location.hash, location.pathname, location.search, navigate],
  );

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
      <AutomateHub tab={routeTab} onTabChange={navigateToTab} />
    </PolicyGateProvider>
  );
}
