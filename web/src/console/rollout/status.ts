import type { operations } from "@maintenance/api-client-ts";

export type ConsoleRolloutStatus =
  operations["getConsoleRollout"]["responses"][200]["content"]["application/json"];
type ConsoleRoute = ConsoleRolloutStatus["effective_route"];

function isConsoleRoute(value: unknown): value is ConsoleRoute {
  return value === "legacy" || value === "new_console";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Fail-closed shape and consistency validation for the server-owned decision. */
export function isConsoleRolloutStatus(value: unknown): value is ConsoleRolloutStatus {
  if (!isRecord(value)) return false;
  const structurallyValid =
    value.flag_key === "console_carbon_copy" &&
    typeof value.org_enabled === "boolean" &&
    typeof value.org_rollout_enabled === "boolean" &&
    typeof value.user_opted_in === "boolean" &&
    typeof value.legacy_kill_switch_enabled === "boolean" &&
    typeof value.kill_switch_active === "boolean" &&
    typeof value.effective_new_console === "boolean" &&
    isConsoleRoute(value.effective_route) &&
    isConsoleRoute(value.effective_route_for_opted_in_user) &&
    value.effective_route_for_opted_out_user === "legacy" &&
    typeof value.overrides_individual_toggles === "boolean";
  if (!structurallyValid) return false;

  const optedInRoute =
    value.org_enabled && !value.kill_switch_active ? "new_console" : "legacy";
  const effectiveNewConsole =
    value.user_opted_in && optedInRoute === "new_console";
  return (
    value.org_rollout_enabled === value.org_enabled &&
    value.kill_switch_active === value.legacy_kill_switch_enabled &&
    value.overrides_individual_toggles === value.kill_switch_active &&
    value.effective_route_for_opted_in_user === optedInRoute &&
    value.effective_new_console === effectiveNewConsole &&
    value.effective_route ===
      (effectiveNewConsole ? "new_console" : "legacy")
  );
}

export function requireConsoleRolloutStatus(value: unknown): ConsoleRolloutStatus {
  if (isConsoleRolloutStatus(value)) return value;
  throw new Error("invalid rollout status");
}

/**
 * Treat the backend's effective fields as authoritative, while rejecting an
 * internally inconsistent response fail closed.
 */
export function isNewConsoleRouteEffective(status: ConsoleRolloutStatus): boolean {
  return (
    status.effective_route === "new_console" &&
    status.effective_new_console &&
    status.org_enabled &&
    status.org_rollout_enabled &&
    status.user_opted_in &&
    !status.kill_switch_active &&
    !status.legacy_kill_switch_enabled
  );
}

export function deriveConsoleOptInStatus(
  status: ConsoleRolloutStatus,
  optedIn = status.user_opted_in,
): boolean {
  return (
    optedIn &&
    status.org_enabled &&
    status.org_rollout_enabled &&
    !status.kill_switch_active &&
    !status.legacy_kill_switch_enabled
  );
}
