import { useMemo } from "react";

import { MailScreen, MAIL_ACTIONS } from "../console/mail";
import { PolicyGateProvider } from "../console/policy";
import { useAuth } from "../context/auth";
import { FEATURES, hasAnyFeatureGrant, hasAnyRole, ROLES, type Role } from "../components/shell/nav";

const MAIL_USE_ROLES: readonly Role[] = [
  ROLES.RECEPTIONIST,
  ROLES.ADMIN,
  ROLES.EXECUTIVE,
  ROLES.SUPER_ADMIN,
];

const MAIL_ACTION_SET = new Set<string>(Object.values(MAIL_ACTIONS));

export function MailPage() {
  const { session } = useAuth();
  const roles = session?.roles;
  const featureGrants = useMemo(() => session?.feature_grants ?? [], [session?.feature_grants]);
  const gate = useMemo(
    () => ({
      can: (action: string) => {
        if (featureGrants.includes(action)) return true;
        if (!MAIL_ACTION_SET.has(action)) return false;
        return (
          hasAnyRole(roles, MAIL_USE_ROLES) ||
          hasAnyFeatureGrant(featureGrants, [FEATURES.MAIL_USE])
        );
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