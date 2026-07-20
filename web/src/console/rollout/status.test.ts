import { describe, expect, it } from "vitest";

import {
  isConsoleRolloutStatus,
  isNewConsoleRouteEffective,
  requireConsoleRolloutStatus,
} from "./status";

const rollout = {
  flag_key: "console_carbon_copy",
  org_enabled: true,
  org_rollout_enabled: true,
  user_opted_in: true,
  legacy_kill_switch_enabled: false,
  kill_switch_active: false,
  effective_new_console: true,
  effective_route: "new_console",
  effective_route_for_opted_in_user: "new_console",
  effective_route_for_opted_out_user: "legacy",
  overrides_individual_toggles: false,
} as const;

describe("console rollout status authority", () => {
  it("accepts the complete and internally consistent backend authority response", () => {
    expect(isConsoleRolloutStatus(rollout)).toBe(true);
  });

  it.each([
    ["wrong authority flag", { flag_key: "new_console" }],
    ["malformed route", { effective_route: "console" }],
    ["malformed kill switch", { kill_switch_active: "false" }],
    ["missing org rollout", { org_rollout_enabled: undefined }],
    ["org flag disagreement", { org_rollout_enabled: false }],
    ["kill-switch disagreement", { legacy_kill_switch_enabled: true }],
    ["current effective boolean disagreement", { effective_new_console: false }],
    ["current route disagreement", { effective_route: "legacy" }],
    ["opted-in route disagreement", { effective_route_for_opted_in_user: "legacy" }],
    ["opted-out route disagreement", { effective_route_for_opted_out_user: "new_console" }],
    ["override disagreement", { overrides_individual_toggles: true }],
  ])("rejects %s", (_label, overrides) => {
    expect(isConsoleRolloutStatus({ ...rollout, ...overrides })).toBe(false);
  });

  it.each([
    [
      "disabled org",
      {
        org_enabled: false,
        org_rollout_enabled: false,
        effective_new_console: false,
        effective_route: "legacy",
        effective_route_for_opted_in_user: "legacy",
      },
    ],
    [
      "opted-out user",
      {
        user_opted_in: false,
        effective_new_console: false,
        effective_route: "legacy",
      },
    ],
    [
      "active kill switch",
      {
        legacy_kill_switch_enabled: true,
        kill_switch_active: true,
        effective_new_console: false,
        effective_route: "legacy",
        effective_route_for_opted_in_user: "legacy",
        overrides_individual_toggles: true,
      },
    ],
  ])("accepts a consistent %s response", (_label, overrides) => {
    expect(isConsoleRolloutStatus({ ...rollout, ...overrides })).toBe(true);
  });

  it("requires both server-owned effective fields to select the new console", () => {
    expect(isNewConsoleRouteEffective(rollout)).toBe(true);
    expect(isNewConsoleRouteEffective({ ...rollout, effective_new_console: false })).toBe(false);
    expect(isNewConsoleRouteEffective({ ...rollout, effective_route: "legacy" })).toBe(false);
  });

  it("rejects malformed mutation responses fail closed", () => {
    expect(() => requireConsoleRolloutStatus({ ...rollout, flag_key: 7 })).toThrow(
      "invalid rollout status",
    );
  });
});
