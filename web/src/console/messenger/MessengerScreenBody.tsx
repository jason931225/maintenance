// 메신저 screen body (ConsoleShell nav "messenger") — composition only. The real
// surface (thread/channel list, message pane, presence, ack/quote/todo/mute,
// object-card drag) already lives in `MessengerConsoleScreen` (§4-18: no
// rebuild); this body binds the authenticated session props AND the policy gate.
//
// Blank-plane fix (same as ModuleFinanceScreenBody): the ConsoleShell mounts
// screen bodies with NO ambient policy provider, so `usePolicyGate()` falls
// through to the DENY_ALL default and every gated affordance — the whole
// messenger surface — renders nothing. Cedar's bulk-authorize is shadow-only
// today (legacy RBAC is the sole enforcer) and its authoring schema does not
// authorize the dotted `messenger.*` actions, so a BulkPolicyGateProvider would
// deny every one. Gate on the same role/feature model the legacy
// ConsoleModuleRoute (`/modules?screen=msgr`) already uses, so both entry
// points agree; the backend re-authorizes every call.
import { useMemo } from "react";
import { useSearchParams } from "react-router";

import { useActiveBranchId, useAuth } from "../../context/auth";
import { PolicyGateProvider, type PolicyGate } from "../policy";
import { MESSENGER_ACTIONS } from "./constants";
import { MessengerConsoleScreen } from "./MessengerConsoleScreen";

// Comms is ungated per nav (every persona has messaging): all six roles may use
// the messenger. Mirrors ConsoleModuleRoute's MESSENGER_ROLES.
const MESSENGER_ROLES = new Set([
  "SUPER_ADMIN",
  "ADMIN",
  "EXECUTIVE",
  "MECHANIC",
  "RECEPTIONIST",
  "MEMBER",
]);

const MESSENGER_ACTION_SET = new Set<string>(Object.values(MESSENGER_ACTIONS));

export function MessengerScreenBody() {
  const { session } = useAuth();
  const activeBranchId = useActiveBranchId();
  const [searchParams] = useSearchParams();
  const roles = session?.roles;
  const featureGrants = session?.feature_grants;

  const gate = useMemo<PolicyGate>(
    () => ({
      can: (action) => {
        if (featureGrants?.includes(action)) return true;
        if (MESSENGER_ACTION_SET.has(action)) {
          return roles?.some((role) => MESSENGER_ROLES.has(role)) ?? false;
        }
        return false;
      },
    }),
    [featureGrants, roles],
  );

  return (
    <PolicyGateProvider gate={gate}>
      <MessengerConsoleScreen
        accessToken={session?.access_token}
        branchId={activeBranchId}
        currentUserId={session?.user_id}
        requestedThreadId={searchParams.get("thread") ?? undefined}
      />
    </PolicyGateProvider>
  );
}
