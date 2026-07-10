import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import { useAuth } from "../../context/auth";
import { ApprovalCompose } from "../appr/ApprovalCompose";
import { MESSENGER_ACTIONS, MessengerConsoleScreen } from "../messenger";
import { PolicyGateProvider } from "../policy";
import { GenericModuleScreen } from "./GenericModuleScreen";
import { getModuleScreen } from "./moduleScreens";

const MODULE_READ_ROLES = new Set([
  "SUPER_ADMIN",
  "ADMIN",
  "EXECUTIVE",
  "MECHANIC",
  "RECEPTIONIST",
]);

const MESSENGER_ROLES = new Set([
  "SUPER_ADMIN",
  "ADMIN",
  "EXECUTIVE",
  "MECHANIC",
  "RECEPTIONIST",
  "MEMBER",
]);

const MESSENGER_ACTION_SET = new Set<string>(Object.values(MESSENGER_ACTIONS));
const APPR_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "EXECUTIVE", "MECHANIC", "RECEPTIONIST", "MEMBER"]);

function sessionCanReadModule(roles: readonly string[] | undefined): boolean {
  return roles?.some((role) => MODULE_READ_ROLES.has(role)) ?? false;
}

export function ConsoleModuleRoute() {
  const { api, session } = useAuth();
  const [searchParams] = useSearchParams();
  const screen = searchParams.get("screen") ?? "finance";
  const config = getModuleScreen(screen);
  const featureGrants = useMemo(() => session?.feature_grants ?? [], [session?.feature_grants]);
  const roles = session?.roles;

  const messengerGate = useMemo(
    () => {
      return {
        can: (action: string) => {
          if (featureGrants.includes(action)) return true;
          if (MESSENGER_ACTION_SET.has(action)) {
            return roles?.some((role) => MESSENGER_ROLES.has(role)) ?? false;
          }
          return false;
        },
      };
    },
    [featureGrants, roles],
  );

  const apprGate = useMemo(
    () => {
      return {
        can: (action: string) => {
          if (featureGrants.includes(action)) return true;
          if (action.startsWith("appr.")) {
            return roles?.some((role) => APPR_ROLES.has(role)) ?? false;
          }
          return false;
        },
      };
    },
    [featureGrants, roles],
  );

  const gate = useMemo(
    () => {
      return {
        can: (action: string) => {
          if (featureGrants.includes(action)) return true;
          if (action === config.policy.read) return sessionCanReadModule(roles);
          return false;
        },
      };
    },
    [config.policy.read, featureGrants, roles],
  );

  if (screen === "msgr") {
    return (
      <PolicyGateProvider gate={messengerGate}>
        <MessengerConsoleScreen
          accessToken={session?.access_token}
          branchId={session?.branches?.[0]}
          currentUserId={session?.user_id}
        />
      </PolicyGateProvider>
    );
  }

  if (screen === "appr") {
    return (
      <PolicyGateProvider gate={apprGate}>
        <ApprovalCompose bearerToken={session?.access_token} currentUserId={session?.user_id} />
      </PolicyGateProvider>
    );
  }

  return (
    <PolicyGateProvider gate={gate}>
      <GenericModuleScreen api={api} config={config} />
    </PolicyGateProvider>
  );
}
