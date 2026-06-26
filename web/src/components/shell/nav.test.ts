import { describe, expect, it } from "vitest";

import {
  GROUP_ROLES,
  NAV_GROUPS,
  ROLES,
  hasAnyRole,
  hasGroupAdminRole,
  isNavItemVisible,
  isPendingMember,
} from "./nav";

/** Every nav item key declared in NAV_GROUPS. */
const ALL_ITEM_KEYS = NAV_GROUPS.flatMap((group) =>
  group.items.map((item) => item.key),
);

/** Visible nav item keys for a session carrying `roles`, in declaration order. */
function visibleItems(
  roles: readonly string[],
  groupRoles?: readonly string[],
): string[] {
  return ALL_ITEM_KEYS.filter((key) =>
    isNavItemVisible(key, roles, groupRoles),
  );
}

// Expected visible nav per role, derived from the backend permission matrix in
// backend/crates/platform/authz/src/lib.rs. This is the regression guard: if
// nav gating drifts from the backend authz model, one of these breaks.
const EXPECTED_VISIBLE: Record<string, string[]> = {
  [ROLES.SUPER_ADMIN]: [
    "dispatch",
    "dispatch-map",
    "intake",
    "approvals",
    "daily-plan",
    "inspection",
    "messenger",
    "support",
    "kpi",
    "ops",
    "reporting",
    "integrity",
    "equipment",
    "equipment-manage",
    "catalog",
    "financial",
    "org",
    "sites",
    "location",
    "employees",
    "users",
    "email",
    "security",
    "profile",
  ],
  [ROLES.ADMIN]: [
    "dispatch",
    "dispatch-map",
    "intake",
    "approvals",
    "daily-plan",
    "inspection",
    "messenger",
    "support",
    "kpi",
    "ops",
    "reporting",
    "equipment",
    "equipment-manage",
    "catalog",
    "financial",
    "org",
    "sites",
    "location",
    "employees",
    "users",
    "email",
    "security",
    "profile",
  ],
  // Executive: KPI yes; approvals/daily-plan/users/org/security no. Profile is
  // shared; reporting (ExcelDownload) is allowed for every role.
  [ROLES.EXECUTIVE]: [
    "dispatch",
    "dispatch-map",
    "intake",
    "messenger",
    "support",
    "kpi",
    "reporting",
    "integrity",
    "equipment",
    "equipment-manage",
    "financial",
    "location",
    "employees",
    "profile",
  ],
  // Mechanic: operational pages only; daily-plan yes (DailyPlanRequest); no
  // approvals/kpi/users/org/security. reporting is shared (ExcelDownload [A...]).
  [ROLES.MECHANIC]: [
    "dispatch",
    "dispatch-map",
    "intake",
    "daily-plan",
    "messenger",
    "support",
    "reporting",
    "equipment",
    "financial",
    "location",
    "profile",
  ],
  // Receptionist: same surface as mechanic minus daily-plan (no DailyPlanRequest).
  [ROLES.RECEPTIONIST]: [
    "dispatch",
    "dispatch-map",
    "intake",
    "messenger",
    "support",
    "reporting",
    "equipment",
    "financial",
    "location",
    "profile",
  ],
  // Member (just signed up, no role grant): default-deny. The backend denies
  // every Feature but Login, so the nav shows ONLY Profile — never a destination
  // that would 403.
  [ROLES.MEMBER]: ["profile"],
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
      expect(isNavItemVisible("sites", [role])).toBe(false);
      expect(isNavItemVisible("email", [role])).toBe(false);
    }
  });

  it("shows the mail-account config (MailAccountManage) only to ADMIN and SUPER_ADMIN", () => {
    expect(isNavItemVisible("email", [ROLES.ADMIN])).toBe(true);
    expect(isNavItemVisible("email", [ROLES.SUPER_ADMIN])).toBe(true);
    expect(isNavItemVisible("email", [ROLES.EXECUTIVE])).toBe(false);
    expect(isNavItemVisible("email", [ROLES.MECHANIC])).toBe(false);
    expect(isNavItemVisible("email", [ROLES.RECEPTIONIST])).toBe(false);
    expect(isNavItemVisible("email", [ROLES.MEMBER])).toBe(false);
  });


  it("shows the employee directory to ADMIN, EXECUTIVE, and SUPER_ADMIN", () => {
    expect(isNavItemVisible("employees", [ROLES.ADMIN])).toBe(true);
    expect(isNavItemVisible("employees", [ROLES.EXECUTIVE])).toBe(true);
    expect(isNavItemVisible("employees", [ROLES.SUPER_ADMIN])).toBe(true);
    expect(isNavItemVisible("employees", [ROLES.MECHANIC])).toBe(false);
    expect(isNavItemVisible("employees", [ROLES.RECEPTIONIST])).toBe(false);
  });

  it("shows user and org management only to ADMIN and SUPER_ADMIN", () => {
    for (const key of ["users", "org", "sites"]) {
      expect(isNavItemVisible(key, [ROLES.ADMIN])).toBe(true);
      expect(isNavItemVisible(key, [ROLES.SUPER_ADMIN])).toBe(true);
      expect(isNavItemVisible(key, [ROLES.EXECUTIVE])).toBe(false);
      expect(isNavItemVisible(key, [ROLES.MECHANIC])).toBe(false);
      expect(isNavItemVisible(key, [ROLES.RECEPTIONIST])).toBe(false);
    }
  });

  it("shows group management only to GROUP_ADMIN grants, not tenant admins alone", () => {
    expect(isNavItemVisible("group", [ROLES.SUPER_ADMIN])).toBe(false);
    expect(isNavItemVisible("group", [ROLES.ADMIN])).toBe(false);
    expect(isNavItemVisible("group", [ROLES.MEMBER], [GROUP_ROLES.GROUP_ADMIN])).toBe(true);
    expect(isNavItemVisible("group", [ROLES.MEMBER], [GROUP_ROLES.GROUP_VIEWER])).toBe(false);
    expect(hasGroupAdminRole([GROUP_ROLES.GROUP_ADMIN])).toBe(true);
    expect(hasGroupAdminRole([GROUP_ROLES.GROUP_VIEWER])).toBe(false);
    expect(visibleItems([ROLES.MEMBER], [GROUP_ROLES.GROUP_ADMIN])).toEqual([
      "group",
      "profile",
    ]);
  });

  it("shows KPI only to ADMIN, EXECUTIVE, and SUPER_ADMIN", () => {
    expect(isNavItemVisible("kpi", [ROLES.ADMIN])).toBe(true);
    expect(isNavItemVisible("kpi", [ROLES.EXECUTIVE])).toBe(true);
    expect(isNavItemVisible("kpi", [ROLES.SUPER_ADMIN])).toBe(true);
    expect(isNavItemVisible("kpi", [ROLES.MECHANIC])).toBe(false);
    expect(isNavItemVisible("kpi", [ROLES.RECEPTIONIST])).toBe(false);
  });

  it("shows inspection (InspectionScheduleManage) only to ADMIN and SUPER_ADMIN", () => {
    expect(isNavItemVisible("inspection", [ROLES.ADMIN])).toBe(true);
    expect(isNavItemVisible("inspection", [ROLES.SUPER_ADMIN])).toBe(true);
    expect(isNavItemVisible("inspection", [ROLES.EXECUTIVE])).toBe(false);
    expect(isNavItemVisible("inspection", [ROLES.MECHANIC])).toBe(false);
    expect(isNavItemVisible("inspection", [ROLES.RECEPTIONIST])).toBe(false);
  });

  it("shows integrity (IntegrityFindingsRead) only to EXECUTIVE and SUPER_ADMIN", () => {
    // Labor-law sensitivity: ADMIN is deliberately excluded (matrix [D,D,D,D,A,A]).
    expect(isNavItemVisible("integrity", [ROLES.EXECUTIVE])).toBe(true);
    expect(isNavItemVisible("integrity", [ROLES.SUPER_ADMIN])).toBe(true);
    expect(isNavItemVisible("integrity", [ROLES.ADMIN])).toBe(false);
    expect(isNavItemVisible("integrity", [ROLES.MECHANIC])).toBe(false);
    expect(isNavItemVisible("integrity", [ROLES.RECEPTIONIST])).toBe(false);
  });

  it("shows daily-plan to DailyPlanRequest holders only", () => {
    expect(isNavItemVisible("daily-plan", [ROLES.MECHANIC])).toBe(true);
    expect(isNavItemVisible("daily-plan", [ROLES.ADMIN])).toBe(true);
    expect(isNavItemVisible("daily-plan", [ROLES.SUPER_ADMIN])).toBe(true);
    expect(isNavItemVisible("daily-plan", [ROLES.EXECUTIVE])).toBe(false);
    expect(isNavItemVisible("daily-plan", [ROLES.RECEPTIONIST])).toBe(false);
  });

  it("shows shared pages to every granted (non-MEMBER) role", () => {
    // The five operational roles all see the shared pages. A bare MEMBER is
    // default-denied every one of them (asserted separately below).
    const grantedRoles = Object.values(ROLES).filter(
      (role) => role !== ROLES.MEMBER,
    );
    for (const role of grantedRoles) {
      for (const key of ["dispatch", "dispatch-map", "intake", "messenger", "support", "reporting", "equipment", "financial", "location", "profile"]) {
        expect(isNavItemVisible(key, [role])).toBe(true);
      }
    }
  });

  it("default-denies a no-grant MEMBER everything but Profile", () => {
    // The dead-role fix: a just-signed-up MEMBER (or an empty roles claim) must
    // see ONLY Profile — every other destination 403s on the backend.
    for (const roles of [["MEMBER"], [] as string[], undefined]) {
      expect(visibleItems(roles ?? [])).toEqual(["profile"]);
      expect(isNavItemVisible("profile", roles)).toBe(true);
      for (const key of [
        "dispatch",
        "dispatch-map",
        "intake",
        "messenger",
        "support",
        "reporting",
        "equipment",
        "financial",
        "location",
        "employees",
        "group",
        "approvals",
        "kpi",
        "users",
        "security",
      ]) {
        expect(isNavItemVisible(key, roles)).toBe(false);
      }
    }
  });

  it("isPendingMember flags an empty or MEMBER-only roles claim", () => {
    expect(isPendingMember(undefined)).toBe(true);
    expect(isPendingMember([])).toBe(true);
    expect(isPendingMember(["MEMBER"])).toBe(true);
    expect(isPendingMember(["MECHANIC"])).toBe(false);
    expect(isPendingMember(["MEMBER", "ADMIN"])).toBe(false);
  });

  it("respects multiple roles by unioning their entitlements", () => {
    // A user with both MECHANIC and ADMIN sees the admin surface too.
    expect(visibleItems([ROLES.MECHANIC, ROLES.ADMIN])).toEqual(
      EXPECTED_VISIBLE[ROLES.ADMIN],
    );
  });

  it("default-denies every gated page (incl. shared pages) when roles are missing", () => {
    // Default-deny: an undefined/empty roles claim is a no-grant session that the
    // backend 403s on every Feature but Login, so the nav surfaces only Profile.
    // Shared pages are now gated too (a phantom-ungated dispatch link would 403).
    expect(isNavItemVisible("dispatch", undefined)).toBe(false);
    expect(isNavItemVisible("dispatch", [])).toBe(false);
    expect(isNavItemVisible("approvals", undefined)).toBe(false);
    expect(isNavItemVisible("group", [ROLES.ADMIN])).toBe(false);
    expect(isNavItemVisible("group", undefined)).toBe(false);
    expect(isNavItemVisible("kpi", [])).toBe(false);
    expect(isNavItemVisible("security", undefined)).toBe(false);
    // Profile stays visible — it is the one surface a no-grant session can use.
    expect(isNavItemVisible("profile", undefined)).toBe(true);
    expect(isNavItemVisible("profile", [])).toBe(true);
  });

  it("hasAnyRole matches against the supplied allowlist", () => {
    expect(hasAnyRole([ROLES.ADMIN], [ROLES.SUPER_ADMIN, ROLES.ADMIN])).toBe(true);
    expect(hasAnyRole([ROLES.MECHANIC], [ROLES.SUPER_ADMIN, ROLES.ADMIN])).toBe(false);
    expect(hasAnyRole(undefined, [ROLES.ADMIN])).toBe(false);
    expect(hasAnyRole([], [ROLES.ADMIN])).toBe(false);
  });
});
