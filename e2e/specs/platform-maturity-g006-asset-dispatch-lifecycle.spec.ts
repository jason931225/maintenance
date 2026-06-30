import { test, expect } from "@playwright/test";

import assetMatrix from "../../docs/benchmarks/g006-asset-dispatch-lifecycle-matrix.json" with { type: "json" };
import routeAudit from "../../docs/benchmarks/enterprise-ui-route-audit.json" with { type: "json" };

const GOAL_ID = "G006-assets-equipment-inventory-dispatch";

test.describe("G006 asset/equipment/dispatch lifecycle contract", () => {
  test("maps every G006 route to asset lifecycle browser stories without claiming live closure", () => {
    expect(assetMatrix.goalId).toBe(GOAL_ID);
    expect(assetMatrix.nonClaimPolicy).toContain("G009");

    const matrixRoutes = new Map(assetMatrix.routePaths.map((row) => [row.path, row]));
    const auditRows = new Map(routeAudit.routeCoverage.map((row) => [row.canonicalPath, row]));
    const g006AuditRows = routeAudit.routeCoverage.filter((row) => row.ownerLane.startsWith("G006"));

    expect(g006AuditRows.length).toBeGreaterThanOrEqual(9);
    for (const auditRow of g006AuditRows) {
      expect(matrixRoutes.has(auditRow.canonicalPath), `${auditRow.canonicalPath} must be in G006 matrix`).toBeTruthy();
    }

    for (const route of assetMatrix.routePaths) {
      const auditRow = auditRows.get(route.path);
      expect(auditRow, `${route.path} must exist in route audit`).toBeTruthy();
      expect(auditRow?.ownerLane, `${route.path} must be G006-owned`).toContain("G006");
      expect(auditRow?.e2eSpec, `${route.path} must require browser story`).toContain("Required browser");
      expect(auditRow?.sourceObject, `${route.path} must include asset/equipment source object`).toContain("equipment");
      expect(auditRow?.lifecycleStates, `${route.path} must include transfer lifecycle`).toContain("transfer pending");
      expect(auditRow?.denialScopeTest, `${route.path} must deny wrong-org mutation`).toContain("Wrong org");
      expect(auditRow?.groupScopeStory, `${route.path} must preserve KNL operator story`).toContain("KNL operator");
      expect(auditRow?.screenshotTraceEvidence, `${route.path} must not falsely claim live screenshot/trace closure`).toContain("Pending");
      expect(route.requiredStory.length, `${route.path} must have a concrete required story`).toBeGreaterThan(56);
    }
  });

  test("records owner/operator, transfer, search, geodata, dispatch, and cost evidence surfaces", () => {
    expect(assetMatrix.backendContracts.length).toBeGreaterThanOrEqual(12);
    expect(assetMatrix.frontendContracts.length).toBeGreaterThanOrEqual(11);
    expect(assetMatrix.requiredE2eSpecs).toContain("e2e/specs/admin-05-equipment.spec.ts");
    expect(assetMatrix.requiredE2eSpecs).toContain("e2e/specs/admin-09-dispatch.spec.ts");
    expect(assetMatrix.requiredE2eSpecs).toContain("e2e/specs/admin-23-equipment-timeline-graph.spec.ts");
    expect(assetMatrix.requiredWebTests).toContain("web/src/features/equipment/EquipmentManagementPanel.test.tsx");
    expect(assetMatrix.requiredWebTests).toContain("web/src/pages/DispatchMapPage.test.tsx");
    expect(assetMatrix.requiredBackendTests).toContain("backend/crates/registry/rest/tests/equipment_admin.rs");
    expect(assetMatrix.requiredBackendTests).toContain("backend/crates/dispatch/adapter-postgres/tests/p1_dispatch.rs");
    expect(assetMatrix.safetyAssertions.join("\n")).toContain("Legal owner and operating customer/site are separate concepts");
    expect(assetMatrix.safetyAssertions.join("\n")).toContain("Group admin equipment creation must select the target subsidiary owner org");
    expect(assetMatrix.safetyAssertions.join("\n")).toContain("Equipment search must cover equipment number");
    expect(assetMatrix.safetyAssertions.join("\n")).toContain("P1 dispatch requires priority P1");
  });

  test("keeps downstream dependencies explicit for work orders, finance, and catalog inventory", () => {
    const auditRows = new Map(routeAudit.routeCoverage.map((row) => [row.canonicalPath, row]));

    for (const dependency of assetMatrix.dependencyRoutes) {
      const auditRow = auditRows.get(dependency.path);
      expect(auditRow, `${dependency.path} must exist in route audit`).toBeTruthy();
      const combined = `${auditRow?.ownerLane} ${auditRow?.sourceObject} ${auditRow?.e2eSpec} ${auditRow?.groupScopeStory}`;
      expect(combined, `${dependency.path} must declare ${dependency.expectedDependency}`).toContain(dependency.expectedDependency);
      expect(dependency.requiredStory.length, `${dependency.path} dependency story must be concrete`).toBeGreaterThan(56);
    }
  });
});
