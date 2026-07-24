import { describe, expect, it } from "vitest";

import {
  FEATURES,
  EXPOSED_SCREEN_KEYS,
  MOUNTED_SCREEN_KEYS,
  NAV_GROUPS,
  ROLES,
  consoleScreenPath,
  defaultScreen,
  isExposedScreenKey,
  isNavItemVisible,
  screenFromConsolePath,
  visibleConsoleNav,
} from "./nav";
import type { ConsoleGrants } from "./nav";
import { SCREEN_REGISTRY } from "../screens/registry";

const grants = (roles: string[], featureGrants: string[] = []): ConsoleGrants => ({
  roles,
  featureGrants,
});

function screens(
  g: ConsoleGrants,
  exposed = EXPOSED_SCREEN_KEYS,
): Set<string> {
  return new Set(
    visibleConsoleNav(g, exposed).flatMap((group) => group.items.map((i) => i.screen)),
  );
}

describe("console nav deny-by-omission", () => {
  it("exposes only the ADR-0025-reviewed sales vertical slice", () => {
    const s = screens(grants([ROLES.MEMBER]));
    expect(MOUNTED_SCREEN_KEYS).toEqual(
      expect.arrayContaining(["overview", "attendance", "mywork", "people", "sales", "inventory", "mail"]),
    );
    expect(EXPOSED_SCREEN_KEYS).toEqual(["sales"]);
    // The sole exposed screen remains deny-by-omission for a no-grant member.
    expect(s).toEqual(new Set());
  });

  it("shows personal Attendance to a no-grant member only in mounted inventory", () => {
    const mounted = screens(grants([ROLES.MEMBER]), MOUNTED_SCREEN_KEYS);
    const production = screens(grants([ROLES.MEMBER]));

    expect(mounted.has("attendance")).toBe(true);
    expect(mounted.has("people")).toBe(false);
    expect(mounted.has("payroll")).toBe(false);
    expect(mounted.has("policy")).toBe(false);
    expect(mounted.has("workflow")).toBe(false);
    expect(mounted.has("sales")).toBe(false);

    // Product exposure remains unchanged: Attendance is mounted but DARK.
    expect(production.has("attendance")).toBe(false);
    expect(isExposedScreenKey("attendance")).toBe(false);
    expect(EXPOSED_SCREEN_KEYS).toEqual(["sales"]);
  });

  it("hides governance/identity surfaces from a non-privileged persona", () => {
    const s = screens(
      grants([ROLES.MECHANIC], [FEATURES.WORK_ORDER_READ_ALL]),
      MOUNTED_SCREEN_KEYS,
    );
    // sensitive — omitted
    expect(s.has("policy")).toBe(false);
    expect(s.has("audit")).toBe(false);
    expect(s.has("compliance")).toBe(false);
    expect(s.has("people")).toBe(false);
    expect(s.has("payroll")).toBe(false);
    expect(s.has("workflow")).toBe(false);
    // planned operational surfaces stay DARK even with an otherwise sufficient grant
    expect(s.has("dispatch")).toBe(false);
  });

  it("shows management analytics + HR to ADMIN, but never RoleManage surfaces", () => {
    const s = screens(grants([ROLES.ADMIN]), MOUNTED_SCREEN_KEYS);
    expect(s.has("people")).toBe(true);
    expect(s.has("attendance")).toBe(true);
    expect(s.has("payroll")).toBe(false);
    expect(s.has("audit")).toBe(true);
    expect(s.has("dashboard")).toBe(true);
    expect(s.has("attendance")).toBe(true);
    expect(s.has("sales")).toBe(true);
    // RoleManage-tier is SUPER_ADMIN-only, never unlocked for ADMIN
    expect(s.has("policy")).toBe(false);
    expect(s.has("workflow")).toBe(false);
    // integrity/compliance excludes ADMIN by design
    expect(s.has("compliance")).toBe(false);
  });

  it("unlocks RoleManage surfaces for SUPER_ADMIN", () => {
    const s = screens(grants([ROLES.SUPER_ADMIN]), MOUNTED_SCREEN_KEYS);
    expect(s.has("policy")).toBe(true);
    expect(s.has("workflow")).toBe(true);
    expect(s.has("scheduled")).toBe(true);
    expect(s.has("compliance")).toBe(false); // planned, but no mounted body yet
  });

  it("preserves mounted-inventory authz filtering without exposing DARK screens", () => {
    const s = screens(
      grants([ROLES.MEMBER], [FEATURES.KPI_READ, FEATURES.EMPLOYEE_DIRECTORY_READ]),
      MOUNTED_SCREEN_KEYS,
    );
    expect(s.has("dashboard")).toBe(true);
    expect(s.has("attendance")).toBe(true);
    expect(s.has("people")).toBe(true);
    expect(s.has("attendance")).toBe(true);
    expect(s.has("payroll")).toBe(false);
    expect(s.has("audit")).toBe(false); // different feature — still hidden
  });

  it("mounts sales for its backend-aligned management role or explicit grant only", () => {
    expect(
      screens(grants([ROLES.EXECUTIVE]), MOUNTED_SCREEN_KEYS).has("sales"),
    ).toBe(true);
    expect(
      screens(
        grants([ROLES.MEMBER], [FEATURES.SALES_MANAGE]),
        MOUNTED_SCREEN_KEYS,
      ).has("sales"),
    ).toBe(true);
    expect(
      screens(grants([ROLES.MEMBER]), MOUNTED_SCREEN_KEYS).has("sales"),
    ).toBe(false);
  });

  it("drops groups that end up empty after filtering", () => {
    const filtered = visibleConsoleNav(grants([ROLES.MEMBER]), MOUNTED_SCREEN_KEYS);
    // ERP is management-gated → the whole group disappears for a MEMBER
    expect(filtered.some((g) => g.labelKey.endsWith("erp"))).toBe(false);
    // overview group survives (ungated items)
    expect(filtered.some((g) => g.labelKey.endsWith("overview"))).toBe(true);
  });

  it("isNavItemVisible: ungated always visible; gated needs an intersection", () => {
    expect(isNavItemVisible(undefined, grants([ROLES.MEMBER]))).toBe(true);
    expect(isNavItemVisible({ roles: [ROLES.ADMIN] }, grants([ROLES.MEMBER]))).toBe(false);
    expect(isNavItemVisible({ roles: [ROLES.ADMIN] }, grants([ROLES.ADMIN]))).toBe(true);
    expect(
      isNavItemVisible({ features: [FEATURES.KPI_READ] }, grants([], [FEATURES.KPI_READ])),
    ).toBe(true);
  });

  it("uses sales as the only approved default for an authorized persona", () => {
    expect(defaultScreen(grants([ROLES.ADMIN]))).toBe("sales");
    expect(defaultScreen(grants([ROLES.MEMBER]))).toBeUndefined();
  });

  it("keeps every production-visible destination mounted and every planned destination DARK", () => {
    const registered = new Set(Object.keys(SCREEN_REGISTRY));
    const exposed = new Set<string>(EXPOSED_SCREEN_KEYS);
    const declared = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.screen));

    expect(MOUNTED_SCREEN_KEYS.every((key) => registered.has(key))).toBe(true);
    expect(MOUNTED_SCREEN_KEYS).toContain("inventory");
    expect(EXPOSED_SCREEN_KEYS).not.toContain("inventory");
    expect(isExposedScreenKey("inventory")).toBe(false);
    expect(declared.filter((key) => !exposed.has(key))).toEqual(
      expect.arrayContaining(["people", "recruit", "dispatch", "docs", "notif", "directory"]),
    );

    for (const role of Object.values(ROLES)) {
      const visible = screens(grants([role], Object.values(FEATURES)));
      expect([...visible].every((key) => exposed.has(key) && registered.has(key))).toBe(true);
    }
  });

  it("parses only direct console screen paths and emits encoded canonical paths", () => {
    expect(screenFromConsolePath("/console/audit")).toBe("audit");
    expect(screenFromConsolePath("/console/audit/")).toBe("audit");
    expect(screenFromConsolePath("/console/audit/nested")).toBeUndefined();
    expect(screenFromConsolePath("/console/audit%2Fnested")).toBeUndefined();
    expect(screenFromConsolePath("/console/%E0%A4%A")).toBeUndefined();
    expect(consoleScreenPath("a b")).toBe("/console/a%20b");
  });

  it("narrows only production-visible screen keys", () => {
    expect(isExposedScreenKey("sales")).toBe(true);
    expect(isExposedScreenKey("audit")).toBe(false);
    expect(isExposedScreenKey("docs")).toBe(false);
    expect(isExposedScreenKey("unknown")).toBe(false);
  });
});
