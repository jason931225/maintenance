import { describe, expect, it } from "vitest";

import { NAV_GROUPS, ROLES, hasAnyRole, isNavItemVisible } from "./nav";

/** Every nav item key declared in NAV_GROUPS. */
const ALL_ITEM_KEYS = NAV_GROUPS.flatMap((group) =>
  group.items.map((item) => item.key),
);

/** Visible nav item keys for a session carrying `roles`, in declaration order. */
function visibleItems(roles: readonly string[]): string[] {
  return ALL_ITEM_KEYS.filter((key) => isNavItemVisible(key, roles));
}

// Expected visible nav per role, derived from the backend permission matrix in
// backend/crates/platform/authz/src/lib.rs. This is the regression guard: if
// nav gating drifts from the backend authz model, one of these breaks.
const EXPECTED_VISIBLE: Record<string, string[]> = {
  [ROLES.SUPER_ADMIN]: [
    "dispatch",
    "intake",
    "approvals",
    "daily-plan",
    "messenger",
    "support",
    "kpi",
    "ops",
    "equipment",
    "financial",
    "users",
    "org",
    "profile",
    "location",
    "security",
  ],
  [ROLES.ADMIN]: [
    "dispatch",
    "intake",
    "approvals",
    "daily-plan",
    "messenger",
    "support",
    "kpi",
    "ops",
    "equipment",
    "financial",
    "users",
    "org",
    "profile",
    "location",
    "security",
  ],
  // Executive: KPI yes; approvals/daily-plan/users/org/security no. Profile is shared.
  [ROLES.EXECUTIVE]: [
    "dispatch",
    "intake",
    "messenger",
    "support",
    "kpi",
    "equipment",
    "financial",
    "profile",
    "location",
  ],
  // Mechanic: operational pages only; daily-plan yes (DailyPlanRequest); no
  // approvals/kpi/users/org/security.
  [ROLES.MECHANIC]: [
    "dispatch",
    "intake",
    "daily-plan",
    "messenger",
    "support",
    "equipment",
    "financial",
    "profile",
    "location",
  ],
  // Receptionist: same surface as mechanic minus daily-plan (no DailyPlanRequest).
  [ROLES.RECEPTIONIST]: [
    "dispatch",
    "intake",
    "messenger",
    "support",
    "equipment",
    "financial",
    "profile",
    "location",
  ],
};

describe("nav role gating", () => {
  it.each(Object.entries(EXPECTED_VISIBLE))(
    "shows the correct nav items for %s",
    (role, expected) => {
      expect(visibleItems([role])).toEqual(expected);
    },
  );

  it("hides admin-only pages from every non-admin role", () => {
    for (const role of [ROLES.EXECUTIVE, ROLES.MECHANIC, ROLES.RECEPTIONIST]) {
      expect(isNavItemVisible("approvals", [role])).toBe(false);
      expect(isNavItemVisible("security", [role])).toBe(false);
      expect(isNavItemVisible("users", [role])).toBe(false);
      expect(isNavItemVisible("org", [role])).toBe(false);
    }
  });

  it("shows user and org management only to ADMIN and SUPER_ADMIN", () => {
    for (const key of ["users", "org"]) {
      expect(isNavItemVisible(key, [ROLES.ADMIN])).toBe(true);
      expect(isNavItemVisible(key, [ROLES.SUPER_ADMIN])).toBe(true);
      expect(isNavItemVisible(key, [ROLES.EXECUTIVE])).toBe(false);
      expect(isNavItemVisible(key, [ROLES.MECHANIC])).toBe(false);
      expect(isNavItemVisible(key, [ROLES.RECEPTIONIST])).toBe(false);
    }
  });

  it("shows KPI only to ADMIN, EXECUTIVE, and SUPER_ADMIN", () => {
    expect(isNavItemVisible("kpi", [ROLES.ADMIN])).toBe(true);
    expect(isNavItemVisible("kpi", [ROLES.EXECUTIVE])).toBe(true);
    expect(isNavItemVisible("kpi", [ROLES.SUPER_ADMIN])).toBe(true);
    expect(isNavItemVisible("kpi", [ROLES.MECHANIC])).toBe(false);
    expect(isNavItemVisible("kpi", [ROLES.RECEPTIONIST])).toBe(false);
  });

  it("shows daily-plan to DailyPlanRequest holders only", () => {
    expect(isNavItemVisible("daily-plan", [ROLES.MECHANIC])).toBe(true);
    expect(isNavItemVisible("daily-plan", [ROLES.ADMIN])).toBe(true);
    expect(isNavItemVisible("daily-plan", [ROLES.SUPER_ADMIN])).toBe(true);
    expect(isNavItemVisible("daily-plan", [ROLES.EXECUTIVE])).toBe(false);
    expect(isNavItemVisible("daily-plan", [ROLES.RECEPTIONIST])).toBe(false);
  });

  it("shows shared pages to all roles", () => {
    for (const role of Object.values(ROLES)) {
      for (const key of ["dispatch", "intake", "messenger", "support", "equipment", "financial", "location", "profile"]) {
        expect(isNavItemVisible(key, [role])).toBe(true);
      }
    }
  });

  it("respects multiple roles by unioning their entitlements", () => {
    // A user with both MECHANIC and ADMIN sees the admin surface too.
    expect(visibleItems([ROLES.MECHANIC, ROLES.ADMIN])).toEqual(
      EXPECTED_VISIBLE[ROLES.ADMIN],
    );
  });

  it("hides nothing-gated pages and all gated pages when roles are missing", () => {
    // The bug this fixes: an undefined/empty role must not surface admin pages,
    // but must also not hide shared pages behind a phantom gate.
    expect(isNavItemVisible("dispatch", undefined)).toBe(true);
    expect(isNavItemVisible("dispatch", [])).toBe(true);
    expect(isNavItemVisible("approvals", undefined)).toBe(false);
    expect(isNavItemVisible("kpi", [])).toBe(false);
    expect(isNavItemVisible("security", undefined)).toBe(false);
  });

  it("hasAnyRole matches against the supplied allowlist", () => {
    expect(hasAnyRole([ROLES.ADMIN], [ROLES.SUPER_ADMIN, ROLES.ADMIN])).toBe(true);
    expect(hasAnyRole([ROLES.MECHANIC], [ROLES.SUPER_ADMIN, ROLES.ADMIN])).toBe(false);
    expect(hasAnyRole(undefined, [ROLES.ADMIN])).toBe(false);
    expect(hasAnyRole([], [ROLES.ADMIN])).toBe(false);
  });
});
