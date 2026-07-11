// 자산 screen body — composition only. The real surface (equipment master list,
// lifecycle timeline ribbon, relationship graph, cost ledger + lifecycle-cost
// summary, object-action catalog) already lives in GenericModuleScreen +
// assetModuleScreen (console/modules/*); this body binds the real authenticated
// api client AND the policy gate.
//
// Why this file exists: the nav item `asset` (nav.ts, gated to management roles)
// had NO SCREEN_REGISTRY entry, so clicking it mounted nothing — a blank plane.
// The screen was only reachable at the legacy /modules?screen=asset URL via
// ConsoleModuleRoute. This body is the registry-mountable equivalent; consolidation
// wires `asset: AssetModuleScreen` into screens/registry.ts.
//
// Blank-plane fix (same as ModuleFinanceScreenBody): ConsoleShell mounts screen
// bodies with NO ambient policy provider, so usePolicyGate() would fall through to
// DENY_ALL and GenericModuleScreen gates its whole surface on config.policy.read —
// rendering nothing. Cedar bulk-authorize is shadow-only today (legacy RBAC is the
// sole enforcer), so a BulkPolicyGateProvider would deny everything too. Gate on the
// same role/feature model the legacy ConsoleModuleRoute uses, aligned to the authz
// matrix (platform/authz matrix_row) so every affordance the UI surfaces is one the
// backend will actually authorize:
//   read (work_order_read_all)          → WorkOrderReadAll: RECEPTIONIST..SUPER_ADMIN
//   manage/costRead (equipment_*)       → EquipmentManage/EquipmentCostLedgerRead: ADMIN/EXECUTIVE/SUPER_ADMIN
//   graph (object.view)                 → generic object read; timeline-graph endpoint gates on read only
//   audit/costWrite                     → AuditLogRead/EquipmentCostLedgerWrite: ADMIN/SUPER_ADMIN
// Feature grants always win; every other role is denied by omission (blank plane, as
// intended for the unauthorized). The backend re-authorizes every call.
import { useMemo } from "react";

import { useAuth } from "../../context/auth";
import { PolicyGateProvider, type PolicyGate } from "../policy";
import { GenericModuleScreen } from "./GenericModuleScreen";
import { ASSET_MODULE_ACTIONS, assetModuleScreen } from "./moduleScreens";

const READ_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "EXECUTIVE", "MECHANIC", "RECEPTIONIST"]);
const MANAGE_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "EXECUTIVE"]);
const ADMIN_ROLES = new Set(["SUPER_ADMIN", "ADMIN"]);

export function AssetModuleScreen() {
  const { api, session } = useAuth();
  const roles = session?.roles;
  const featureGrants = session?.feature_grants;

  const gate = useMemo<PolicyGate>(
    () => ({
      can: (action) => {
        if (featureGrants?.includes(action)) return true;
        const has = (set: Set<string>) => roles?.some((role) => set.has(role)) ?? false;
        switch (action) {
          case ASSET_MODULE_ACTIONS.read:
            return has(READ_ROLES);
          case ASSET_MODULE_ACTIONS.manage:
          case ASSET_MODULE_ACTIONS.costRead:
          case ASSET_MODULE_ACTIONS.graph:
            return has(MANAGE_ROLES);
          case ASSET_MODULE_ACTIONS.audit:
          case ASSET_MODULE_ACTIONS.costWrite:
            return has(ADMIN_ROLES);
          default:
            return false;
        }
      },
    }),
    [featureGrants, roles],
  );

  return (
    <PolicyGateProvider gate={gate}>
      <GenericModuleScreen config={assetModuleScreen} api={api} />
    </PolicyGateProvider>
  );
}
