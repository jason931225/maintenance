import { describe, expect, it } from "vitest";

import {
  FEATURES,
  ROLES,
  defaultScreen,
  isNavItemVisible,
  visibleConsoleNav,
} from "./nav";
import type { ConsoleGrants } from "./nav";

const grants = (roles: string[], featureGrants: string[] = []): ConsoleGrants => ({
  roles,
  featureGrants,
});

function screens(g: ConsoleGrants): Set<string> {
  return new Set(visibleConsoleNav(g).flatMap((group) => group.items.map((i) => i.screen)));
}

describe("console nav deny-by-omission", () => {
  it("ungated items (personal + comms) are visible to any authenticated session", () => {
    const s = screens(grants([ROLES.MEMBER]));
    // personal
    expect(s).toContain("overview");
    expect(s).toContain("mywork");
    expect(s).toContain("inbox");
    // comms
    expect(s).toContain("messenger");
    expect(s).toContain("mail");
    expect(s).toContain("notif");
  });

  it("hides governance/identity surfaces from a non-privileged persona", () => {
    const s = screens(grants([ROLES.MECHANIC], [FEATURES.WORK_ORDER_READ_ALL]));
    // sensitive — omitted
    expect(s.has("policy")).toBe(false);
    expect(s.has("audit")).toBe(false);
    expect(s.has("compliance")).toBe(false);
    expect(s.has("hr")).toBe(false);
    expect(s.has("payroll")).toBe(false);
    expect(s.has("workflow")).toBe(false);
    // its own operational surface — visible via the work-order feature grant
    expect(s.has("dispatch")).toBe(true);
  });

  it("shows management analytics + HR to ADMIN, but never RoleManage surfaces", () => {
    const s = screens(grants([ROLES.ADMIN]));
    expect(s.has("hr")).toBe(true);
    expect(s.has("payroll")).toBe(true);
    expect(s.has("audit")).toBe(true);
    expect(s.has("dashboard")).toBe(true);
    // RoleManage-tier is SUPER_ADMIN-only, never unlocked for ADMIN
    expect(s.has("policy")).toBe(false);
    expect(s.has("workflow")).toBe(false);
    // integrity/compliance excludes ADMIN by design
    expect(s.has("compliance")).toBe(false);
  });

  it("unlocks RoleManage surfaces for SUPER_ADMIN", () => {
    const s = screens(grants([ROLES.SUPER_ADMIN]));
    expect(s.has("policy")).toBe(true);
    expect(s.has("workflow")).toBe(true);
    expect(s.has("scheduled")).toBe(true);
    expect(s.has("compliance")).toBe(true);
  });

  it("a feature grant alone (no role) exposes exactly its gated item", () => {
    const s = screens(grants([ROLES.MEMBER], [FEATURES.EMPLOYEE_DIRECTORY_READ]));
    expect(s.has("hr")).toBe(true); // directory feature → HR admin visible
    expect(s.has("payroll")).toBe(true);
    expect(s.has("audit")).toBe(false); // different feature — still hidden
  });

  it("drops groups that end up empty after filtering", () => {
    const filtered = visibleConsoleNav(grants([ROLES.MEMBER]));
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

  it("defaultScreen returns the first visible item", () => {
    expect(defaultScreen(grants([ROLES.ADMIN]))).toBe("overview");
    // even a MEMBER lands on a visible screen (never an empty string)
    expect(screens(grants([ROLES.MEMBER])).has(defaultScreen(grants([ROLES.MEMBER])))).toBe(
      true,
    );
  });
});
