import { test, expect } from "@playwright/test";

import identityMatrix from "../../docs/benchmarks/g004-identity-foundation-matrix.json" with { type: "json" };
import routeAudit from "../../docs/benchmarks/enterprise-ui-route-audit.json" with { type: "json" };

const GOAL_ID = "G004-identity-group-org-people-policy-fou";

test.describe("G004 identity/group/org/people/policy foundation contract", () => {
  test("maps every G004 route to a real browser story without claiming live closure", () => {
    expect(identityMatrix.goalId).toBe(GOAL_ID);
    expect(identityMatrix.nonClaimPolicy).toContain("G009");

    const matrixRoutes = new Map(identityMatrix.routePaths.map((row) => [row.path, row]));
    const auditRows = new Map(routeAudit.routeCoverage.map((row) => [row.canonicalPath, row]));
    const g004AuditRows = routeAudit.routeCoverage.filter((row) => row.ownerLane.includes("G004"));

    expect(g004AuditRows.length).toBeGreaterThanOrEqual(12);
    for (const auditRow of g004AuditRows) {
      expect(matrixRoutes.has(auditRow.canonicalPath), `${auditRow.canonicalPath} must be in G004 matrix`).toBeTruthy();
    }

    for (const route of identityMatrix.routePaths) {
      const auditRow = auditRows.get(route.path);
      expect(auditRow, `${route.path} must exist in route audit`).toBeTruthy();
      expect(auditRow?.ownerLane, `${route.path} must be G004-owned`).toContain("G004");
      expect(auditRow?.e2eSpec, `${route.path} must require browser story`).toContain("Required browser");
      expect(auditRow?.denialScopeTest.length, `${route.path} must specify denial/scope story`).toBeGreaterThan(20);
      expect(auditRow?.groupScopeStory.length, `${route.path} must specify group scope story`).toBeGreaterThan(20);
      expect(auditRow?.screenshotTraceEvidence, `${route.path} must not falsely claim live screenshot/trace closure`).toContain("Pending");
      expect(route.requiredStory.length, `${route.path} must have a concrete required story`).toBeGreaterThan(24);
    }
  });

  test("records policy, passkey, group, and employee lifecycle evidence surfaces", () => {
    expect(identityMatrix.backendContracts.length).toBeGreaterThanOrEqual(6);
    expect(identityMatrix.frontendContracts.length).toBeGreaterThanOrEqual(6);
    expect(identityMatrix.requiredE2eSpecs).toContain("e2e/specs/auth-08-phone-qr-handoff.spec.ts");
    expect(identityMatrix.requiredE2eSpecs).toContain("e2e/specs/admin-25-policy-studio.spec.ts");
    expect(identityMatrix.requiredE2eSpecs).toContain("e2e/specs/admin-24-hr-core.spec.ts");
    expect(identityMatrix.requiredWebTests).toContain("web/src/pages/PolicyStudioPage.test.tsx");
    expect(identityMatrix.requiredBackendTests).toContain("backend/crates/platform/authz/tests/policy.rs");
    expect(identityMatrix.safetyAssertions.join("\n")).toContain("Desktop QR login path");
    expect(identityMatrix.safetyAssertions.join("\n")).toContain("Employee lifecycle");
    expect(identityMatrix.safetyAssertions.join("\n")).toContain("Custom policy");
  });
});
