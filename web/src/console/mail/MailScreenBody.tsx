// 메일 screen body (ConsoleShell nav "mail") — composition only. The real webmail
// surface (folder pane, thread list, read pane, composer, governance/egress,
// attachment ingest/evidence) already lives in `MailScreen` (§4-18: no rebuild),
// which reads its own authenticated api client via useAuth. This body only
// supplies the policy gate.
//
// Blank-plane fix (same as ModuleFinanceScreenBody / MessengerScreenBody): the
// ConsoleShell mounts screen bodies with NO ambient policy provider, so
// `usePolicyGate()` falls through to DENY_ALL and MailScreen's top-level
// `<PolicyGated action={mail.use}>` hides the entire screen. Cedar's
// bulk-authorize is shadow-only today and does not authorize the dotted `mail.*`
// actions, so a BulkPolicyGateProvider would deny every one (verified: the same
// trap LeaveBody documents). Gate on the role model instead — comms is ungated
// per nav (every persona has a mailbox), so all six roles may use mail; the
// backend re-authorizes and enforces egress/SoD on every send/reply/forward.
import { useMemo } from "react";

import { useAuth } from "../../context/auth";
import { PolicyGateProvider, type PolicyGate } from "../policy";
import { MailScreen } from "./MailScreen";
import { MAIL_ACTIONS } from "./mailScreenConfig";

const MAIL_ROLES = new Set([
  "SUPER_ADMIN",
  "ADMIN",
  "EXECUTIVE",
  "MECHANIC",
  "RECEPTIONIST",
  "MEMBER",
]);

const MAIL_ACTION_SET = new Set<string>(Object.values(MAIL_ACTIONS));

export function MailScreenBody() {
  const { session } = useAuth();
  const roles = session?.roles;
  const featureGrants = session?.feature_grants;

  const gate = useMemo<PolicyGate>(
    () => ({
      can: (action) => {
        if (featureGrants?.includes(action)) return true;
        if (MAIL_ACTION_SET.has(action)) {
          return roles?.some((role) => MAIL_ROLES.has(role)) ?? false;
        }
        return false;
      },
    }),
    [featureGrants, roles],
  );

  return (
    <PolicyGateProvider gate={gate}>
      <MailScreen />
    </PolicyGateProvider>
  );
}
