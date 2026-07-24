import { describe, expect, it } from "vitest";

import {
  FEATURES,
  GROUP_ROLES,
  NAV_GROUPS,
  ROLES,
  hasAnyFeatureGrant,
  hasAnyRole,
  hasGroupAdminRole,
  hasGrantedConsoleAccess,
  isNavItemVisible,
  isPendingMember,
  visibleNavItemsForRoles,
} from "./nav";
import { navGroupLabel } from "./nav-labels";

/** Every nav item key declared in NAV_GROUPS. */
const ALL_ITEM_KEYS = NAV_GROUPS.flatMap((group) =>
  group.items.map((item) => item.key),
);

/** Visible nav item keys for a session carrying `roles`, in declaration order. */
function visibleItems(
  roles: readonly string[],
  groupRoles?: readonly string[],
  featureGrants?: readonly string[],
): string[] {
  return ALL_ITEM_KEYS.filter((key) =>
    isNavItemVisible(key, roles, groupRoles, featureGrants),
  );
}

// Expected visible nav per role, derived from the backend permission matrix in
// backend/crates/platform/authz/src/lib.rs. This is the regression guard: if
// nav gating drifts from the backend authz model, one of these breaks.
const EXPECTED_VISIBLE: Record<string, string[]> = {
  [ROLES.SUPER_ADMIN]: [
    "overview",
    "my-attendance",
    "approvals",
    "messenger",
    "mail",
    "dispatch",
    "dispatch-map",
    "intake",
    "daily-plan",
    "collaboration",
    "inspection",
    "facilities",
    "support",
    "ontology",
    "workflows",
    "automate",
    "kpi",
    "intelligence",
    "ops",
    "forecast",
    "config-console",
    "reporting",
    "equipment",
    "equipment-manage",
    "catalog",
    "finance",
    "payroll",
    "financial",
    "employees",
    "leave-management",
    "insurance-assist",
    "policy",
    "integrity",
    "compliance",
    "org",
    "sites",
    "location",
    "users",
    "security",
    "profile",
  ],
  [ROLES.ADMIN]: [
    "overview",
    "my-attendance",
    "approvals",
    "messenger",
    "mail",
    "dispatch",
    "dispatch-map",
    "intake",
    "daily-plan",
    "collaboration",
    "inspection",
    "facilities",
    "support",
    "ontology",
    "kpi",
    "intelligence",
    "ops",
    "forecast",
    "config-console",
    "reporting",
    "equipment",
    "equipment-manage",
    "catalog",
    "finance",
    "payroll",
    "financial",
    "employees",
    "leave-management",
    "insurance-assist",
    "compliance",
    "org",
    "sites",
    "location",
    "users",
    "security",
    "profile",
  ],
  // Executive: ontology/kpi/intelligence/forecast/integrity yes; approvals/
  // daily-plan/ops/config-console/workflows/automate/users/org/security no.
  // Equipment browse/manage remain visible, but sales catalog conversion stays admin-only.
  [ROLES.EXECUTIVE]: [
    "overview",
    "my-attendance",
    "messenger",
    "mail",
    "dispatch",
    "dispatch-map",
    "intake",
    "collaboration",
    "facilities",
    "support",
    "ontology",
    "kpi",
    "intelligence",
    "forecast",
    "reporting",
    "equipment",
    "equipment-manage",
    "finance",
    "payroll",
    "financial",
    "employees",
    "leave-management",
    "insurance-assist",
    "integrity",
    "location",
    "profile",
  ],
  // Mechanic: maintenance operations and personal work surfaces; no mail,
  // approvals/kpi/users/org/security, or equipment-sales management.
  [ROLES.MECHANIC]: [
    "overview",
    "my-attendance",
    "messenger",
    "dispatch",
    "dispatch-map",
    "intake",
    "daily-plan",
    "collaboration",
    "inspection",
    "facilities",
    "support",
    "reporting",
    "equipment",
    "finance",
    "financial",
    "location",
    "profile",
  ],
  // Receptionist: affiliate business-operations surface plus mail; no daily-plan.
  [ROLES.RECEPTIONIST]: [
    "overview",
    "my-attendance",
    "messenger",
    "mail",
    "dispatch",
    "dispatch-map",
    "intake",
    "collaboration",
    "facilities",
    "support",
    "reporting",
    "equipment",
    "finance",
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

  it("keeps personal and department work as the first standalone nav group", () => {
    expect(NAV_GROUPS[0].key).toBe("personal");
    expect(navGroupLabel("personal")).toBe("개인/부서 업무");
    expect(NAV_GROUPS[0].items.map((item) => item.key)).toEqual([
      "overview",
      "my-attendance",
      "approvals",
    ]);

    // Foundry IA: messenger/mail live in the dedicated communication group.
    const comms = NAV_GROUPS.find((group) => group.key === "comms");
    expect(comms?.items.map((item) => item.key)).toEqual(["messenger", "mail"]);

    const operations = NAV_GROUPS.find((group) => group.key === "operations");
    const assets = NAV_GROUPS.find((group) => group.key === "assets");
    expect(operations?.items.map((item) => item.key)).not.toEqual(
      expect.arrayContaining(["overview", "approvals", "messenger", "mail"]),
    );
    expect(assets?.items.map((item) => item.key)).toEqual([
      "equipment",
      "equipment-manage",
      "catalog",
    ]);
  });

  it("groups the Foundry platform and analytics surfaces per the console IA", () => {
    const foundry = NAV_GROUPS.find((group) => group.key === "foundry");
    const analytics = NAV_GROUPS.find((group) => group.key === "analytics");
    expect(foundry?.items.map((item) => item.key)).toEqual([
      "ontology",
      "workflows",
      "automate",
    ]);
    expect(analytics?.items.map((item) => item.key)).toEqual([
      "kpi",
      "intelligence",
      "ops",
      "forecast",
      "config-console",
      "reporting",
    ]);
  });

  it("PBAC-gates the new Foundry/analytics stub surfaces", () => {
    // ontology + forecast: KPI-read gate (ADMIN/EXECUTIVE/SUPER_ADMIN).
    for (const key of ["ontology", "forecast"]) {
      expect(isNavItemVisible(key, [ROLES.ADMIN])).toBe(true);
      expect(isNavItemVisible(key, [ROLES.EXECUTIVE])).toBe(true);
      expect(isNavItemVisible(key, [ROLES.SUPER_ADMIN])).toBe(true);
      expect(isNavItemVisible(key, [ROLES.MECHANIC])).toBe(false);
      expect(isNavItemVisible(key, [ROLES.MEMBER])).toBe(false);
    }
    // automate: RoleManage system-only (SUPER_ADMIN), like the workflow studio.
    expect(isNavItemVisible("automate", [ROLES.SUPER_ADMIN])).toBe(true);
    expect(isNavItemVisible("automate", [ROLES.ADMIN])).toBe(false);
    expect(isNavItemVisible("automate", [ROLES.EXECUTIVE])).toBe(false);
    expect(
      isNavItemVisible("automate", [ROLES.MEMBER], undefined, [
        FEATURES.ROLE_MANAGE,
      ]),
    ).toBe(false);
    // config-console: admin configuration surface.
    expect(isNavItemVisible("config-console", [ROLES.ADMIN])).toBe(true);
    expect(isNavItemVisible("config-console", [ROLES.SUPER_ADMIN])).toBe(true);
    expect(isNavItemVisible("config-console", [ROLES.EXECUTIVE])).toBe(false);
    expect(isNavItemVisible("config-console", [ROLES.MECHANIC])).toBe(false);
  });

  it("shows Facilities only to FacilitiesObserve holders", () => {
    for (const role of [
      ROLES.SUPER_ADMIN,
      ROLES.ADMIN,
      ROLES.EXECUTIVE,
      ROLES.MECHANIC,
      ROLES.RECEPTIONIST,
    ]) {
      expect(isNavItemVisible("facilities", [role])).toBe(true);
    }
    expect(isNavItemVisible("facilities", [ROLES.MEMBER])).toBe(false);
    expect(
      isNavItemVisible("facilities", [ROLES.MEMBER], undefined, [
        FEATURES.FACILITIES_OBSERVE,
      ]),
    ).toBe(true);
  });

  it("hides admin-only pages from every non-admin role", () => {
    for (const role of [ROLES.EXECUTIVE, ROLES.MECHANIC, ROLES.RECEPTIONIST]) {
      expect(isNavItemVisible("approvals", [role])).toBe(false);
      expect(isNavItemVisible("security", [role])).toBe(false);
      expect(isNavItemVisible("users", [role])).toBe(false);
      expect(isNavItemVisible("org", [role])).toBe(false);
      expect(isNavItemVisible("sites", [role])).toBe(false);
      expect(isNavItemVisible("policy", [role])).toBe(false);
      expect(isNavItemVisible("workflows", [role])).toBe(false);
    }
  });

  it("shows the mailbox (MailUse) to built-in holders or an effective MailUse custom grant", () => {
    expect(isNavItemVisible("mail", [ROLES.RECEPTIONIST])).toBe(true);
    expect(isNavItemVisible("mail", [ROLES.ADMIN])).toBe(true);
    expect(isNavItemVisible("mail", [ROLES.EXECUTIVE])).toBe(true);
    expect(isNavItemVisible("mail", [ROLES.SUPER_ADMIN])).toBe(true);
    expect(isNavItemVisible("mail", [ROLES.MECHANIC])).toBe(false);
    expect(isNavItemVisible("mail", [ROLES.MEMBER])).toBe(false);
    expect(
      isNavItemVisible("mail", [ROLES.MEMBER], undefined, [FEATURES.MAIL_USE]),
    ).toBe(true);
  });

  it("lands feature-only custom grants on overview without leaking logistics nav", () => {
    expect(
      visibleItems([ROLES.MEMBER], undefined, [FEATURES.MAIL_USE]),
    ).toEqual(["overview", "mail", "profile"]);
    expect(
      isNavItemVisible("dispatch", [ROLES.MEMBER], undefined, [
        FEATURES.MAIL_USE,
      ]),
    ).toBe(false);
    expect(
      isNavItemVisible("equipment", [ROLES.MEMBER], undefined, [
        FEATURES.MAIL_USE,
      ]),
    ).toBe(false);
    for (const grant of [
      FEATURES.DAILY_PLAN_REQUEST,
      FEATURES.KPI_READ,
      FEATURES.EMPLOYEE_DIRECTORY_READ,
      FEATURES.INTEGRITY_FINDINGS_READ,
    ]) {
      expect(isNavItemVisible("overview", [ROLES.MEMBER], undefined, [grant])).toBe(true);
    }
  });

  it("maps operational persona custom grants to intended non-admin nav surfaces", () => {
    const restrictedSurfaces = [
      "approvals",
      "inspection",
      "kpi",
      "intelligence",
      "ops",
      "reporting",
      "integrity",
      "equipment-manage",
      "catalog",
      "finance",
      "payroll",
      "financial",
      "org",
      "sites",
      "location",
      "employees",
      "leave-management",
      "insurance-assist",
      "users",
      "policy",
      "workflows",
      "security",
    ];

    const cases = [
      {
        persona: "site_operations",
        grants: [
          FEATURES.WORK_ORDER_READ_ALL,
          FEATURES.WORK_ORDER_START,
          FEATURES.WORK_REPORT_SUBMIT,
          FEATURES.EVIDENCE_ATTACH,
          FEATURES.DAILY_PLAN_REQUEST,
        ],
        expected: [
          "overview",
          "messenger",
          "dispatch",
          "dispatch-map",
          "daily-plan",
          "collaboration",
          "support",
          "equipment",
          "profile",
        ],
      },
      {
        persona: "security_guard",
        grants: [
          FEATURES.WORK_ORDER_READ_ALL,
          FEATURES.WORK_ORDER_CREATE,
          FEATURES.WORK_REPORT_SUBMIT,
          FEATURES.EVIDENCE_ATTACH,
        ],
        expected: [
          "overview",
          "messenger",
          "dispatch",
          "dispatch-map",
          "intake",
          "collaboration",
          "support",
          "equipment",
          "profile",
        ],
      },
      {
        persona: "cleaning_staff",
        grants: [
          FEATURES.WORK_ORDER_READ_ALL,
          FEATURES.WORK_ORDER_START,
          FEATURES.WORK_REPORT_SUBMIT,
          FEATURES.EVIDENCE_ATTACH,
          FEATURES.DAILY_PLAN_REQUEST,
        ],
        expected: [
          "overview",
          "messenger",
          "dispatch",
          "dispatch-map",
          "daily-plan",
          "collaboration",
          "support",
          "equipment",
          "profile",
        ],
      },
      {
        persona: "dispatch_office_staff",
        grants: [
          FEATURES.WORK_ORDER_CREATE,
          FEATURES.WORK_ORDER_EDIT_INTAKE,
          FEATURES.WORK_ORDER_READ_ALL,
          FEATURES.TARGET_MANAGE,
          FEATURES.MAIL_USE,
        ],
        expected: [
          "overview",
          "messenger",
          "mail",
          "dispatch",
          "dispatch-map",
          "intake",
          "collaboration",
          "support",
          "equipment",
          "profile",
        ],
      },
    ];

    for (const { persona, grants, expected } of cases) {
      expect(visibleItems([ROLES.MEMBER], undefined, grants), persona).toEqual(
        expected,
      );
      for (const key of restrictedSurfaces) {
        expect(
          isNavItemVisible(key, [ROLES.MEMBER], undefined, grants),
          `${persona}:${key}`,
        ).toBe(false);
      }
    }
  });

  it("keeps policy and workflow studios system-only even if a stale RoleManage feature grant is present", () => {
    for (const key of ["policy", "workflows"]) {
      expect(isNavItemVisible(key, [ROLES.SUPER_ADMIN])).toBe(true);
      expect(isNavItemVisible(key, [ROLES.ADMIN])).toBe(false);
      expect(isNavItemVisible(key, [ROLES.EXECUTIVE])).toBe(false);
      expect(isNavItemVisible(key, [ROLES.MECHANIC])).toBe(false);
      expect(isNavItemVisible(key, [ROLES.RECEPTIONIST])).toBe(false);
      expect(isNavItemVisible(key, [ROLES.MEMBER])).toBe(false);
      expect(
        isNavItemVisible(key, [ROLES.MEMBER], undefined, [
          FEATURES.ROLE_MANAGE,
        ]),
      ).toBe(false);
    }
  });

  it("hides the legacy mail-server config entry because corporate mail is platform-operated", () => {
    expect(ALL_ITEM_KEYS).not.toContain("email");
    expect(isNavItemVisible("email", [ROLES.ADMIN])).toBe(false);
    expect(isNavItemVisible("email", [ROLES.SUPER_ADMIN])).toBe(false);
  });

  it("shows HR directory, leave management, and insurance assist to employee-directory readers", () => {
    for (const key of ["employees", "leave-management", "insurance-assist"]) {
      expect(isNavItemVisible(key, [ROLES.ADMIN])).toBe(true);
      expect(isNavItemVisible(key, [ROLES.EXECUTIVE])).toBe(true);
      expect(isNavItemVisible(key, [ROLES.SUPER_ADMIN])).toBe(true);
      expect(isNavItemVisible(key, [ROLES.MECHANIC])).toBe(false);
      expect(isNavItemVisible(key, [ROLES.RECEPTIONIST])).toBe(false);
      expect(
        isNavItemVisible(key, [ROLES.MEMBER], undefined, [
          FEATURES.EMPLOYEE_DIRECTORY_READ,
        ]),
      ).toBe(true);
    }
  });

  it("shows payroll readiness to employee-directory readers only", () => {
    expect(isNavItemVisible("payroll", [ROLES.ADMIN])).toBe(true);
    expect(isNavItemVisible("payroll", [ROLES.EXECUTIVE])).toBe(true);
    expect(isNavItemVisible("payroll", [ROLES.SUPER_ADMIN])).toBe(true);
    expect(isNavItemVisible("payroll", [ROLES.MECHANIC])).toBe(false);
    expect(isNavItemVisible("payroll", [ROLES.RECEPTIONIST])).toBe(false);
    expect(
      isNavItemVisible("payroll", [ROLES.MEMBER], undefined, [
        FEATURES.EMPLOYEE_DIRECTORY_READ,
      ]),
    ).toBe(true);
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

  it("shows KPI and operations intelligence only to ADMIN, EXECUTIVE, and SUPER_ADMIN", () => {
    for (const key of ["kpi", "intelligence"]) {
      expect(isNavItemVisible(key, [ROLES.ADMIN])).toBe(true);
      expect(isNavItemVisible(key, [ROLES.EXECUTIVE])).toBe(true);
      expect(isNavItemVisible(key, [ROLES.SUPER_ADMIN])).toBe(true);
      expect(isNavItemVisible(key, [ROLES.MECHANIC])).toBe(false);
      expect(isNavItemVisible(key, [ROLES.RECEPTIONIST])).toBe(false);
    }
  });

  it("shows inspection execution to MECHANIC and schedule management to ADMIN/SUPER_ADMIN", () => {
    expect(isNavItemVisible("inspection", [ROLES.ADMIN])).toBe(true);
    expect(isNavItemVisible("inspection", [ROLES.SUPER_ADMIN])).toBe(true);
    expect(isNavItemVisible("inspection", [ROLES.EXECUTIVE])).toBe(false);
    expect(isNavItemVisible("inspection", [ROLES.MECHANIC])).toBe(true);
    expect(isNavItemVisible("inspection", [ROLES.RECEPTIONIST])).toBe(false);
    expect(
      isNavItemVisible("inspection", [ROLES.MEMBER], undefined, [
        FEATURES.INSPECTION_ROUND_COMPLETE,
      ]),
    ).toBe(true);
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
      for (const key of [
        "overview",
        "dispatch",
        "dispatch-map",
        "intake",
        "collaboration",
        "messenger",
        "support",
        "reporting",
        "equipment",
        "finance",
        "financial",
        "location",
        "profile",
      ]) {
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
        "overview",
        "dispatch",
        "dispatch-map",
        "intake",
        "messenger",
        "mail",
        "support",
        "reporting",
        "equipment",
        "finance",
        "financial",
        "payroll",
        "location",
        "employees",
        "group",
        "approvals",
        "kpi",
        "intelligence",
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
    expect(isPendingMember(["MEMBER"], [GROUP_ROLES.GROUP_ADMIN])).toBe(false);
    expect(isPendingMember(["MEMBER"], undefined, [FEATURES.MAIL_USE])).toBe(false);
  });

  it("treats mapped custom feature grants as console access for MEMBER sessions", () => {
    expect(hasGrantedConsoleAccess(["MEMBER"], undefined, [])).toBe(false);
    expect(hasGrantedConsoleAccess(["MEMBER"], undefined, ["role_manage"])).toBe(false);
    expect(hasGrantedConsoleAccess(["MEMBER"], undefined, ["user_manage"])).toBe(false);
    expect(hasGrantedConsoleAccess(["MEMBER"], [GROUP_ROLES.GROUP_ADMIN], [])).toBe(true);
  });

  it("orders the first granted destination by the visible nav registry", () => {
    expect(
      visibleNavItemsForRoles(["MEMBER"], undefined, [FEATURES.MAIL_USE]).find(
        (item) => item.key !== "profile",
      )?.href,
    ).toBe("/overview");
    expect(
      visibleNavItemsForRoles(["MEMBER"], [GROUP_ROLES.GROUP_ADMIN], []).find(
        (item) => item.key !== "profile",
      )?.href,
    ).toBe("/settings/group");
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
    expect(isNavItemVisible("overview", undefined)).toBe(false);
    expect(isNavItemVisible("overview", [])).toBe(false);
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

  it("hasAnyFeatureGrant matches runtime-effective custom-role UI hints", () => {
    expect(hasAnyFeatureGrant([FEATURES.MAIL_USE], [FEATURES.MAIL_USE])).toBe(true);
    expect(hasAnyFeatureGrant([FEATURES.MAIL_USE], [FEATURES.KPI_READ])).toBe(false);
    expect(hasAnyFeatureGrant(undefined, [FEATURES.MAIL_USE])).toBe(false);
    expect(hasAnyFeatureGrant([], [FEATURES.MAIL_USE])).toBe(false);
  });
});
