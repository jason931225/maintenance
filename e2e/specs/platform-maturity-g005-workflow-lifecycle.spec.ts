import { test, expect } from "@playwright/test";

import workflowMatrix from "../../docs/benchmarks/g005-workflow-lifecycle-matrix.json" with { type: "json" };
import routeAudit from "../../docs/benchmarks/enterprise-ui-route-audit.json" with { type: "json" };

const GOAL_ID = "G005-workflow-builder-approvals-work-hub";

test.describe("G005 workflow/approval/Overview lifecycle contract", () => {
  test("maps every G005 route to a source-object browser lifecycle without claiming live closure", () => {
    expect(workflowMatrix.goalId).toBe(GOAL_ID);
    expect(workflowMatrix.nonClaimPolicy).toContain("G009");

    const matrixRoutes = new Map(workflowMatrix.routePaths.map((row) => [row.path, row]));
    const auditRowsByCanonicalPath = new Map(routeAudit.routeCoverage.map((row) => [row.canonicalPath, row]));
    const auditRowsByRawPath = new Map(routeAudit.routeCoverage.map((row) => [row.rawPath ?? row.canonicalPath, row]));
    const auditForMatrixPath = (path: string) => auditRowsByRawPath.get(path) ?? auditRowsByCanonicalPath.get(path);
    const g005AuditRows = routeAudit.routeCoverage.filter((row) => row.ownerLane.startsWith("G005"));

    expect(g005AuditRows.length).toBeGreaterThanOrEqual(6);
    for (const auditRow of g005AuditRows) {
      expect(matrixRoutes.has(auditRow.canonicalPath), `${auditRow.canonicalPath} must be in G005 matrix`).toBeTruthy();
    }

    for (const route of workflowMatrix.routePaths) {
      const auditRow = auditForMatrixPath(route.path);
      expect(auditRow, `${route.path} must exist in route audit`).toBeTruthy();
      expect(auditRow?.ownerLane, `${route.path} must be G005-owned`).toContain("G005");
      expect(auditRow?.e2eSpec, `${route.path} must require browser story`).toContain("Required browser");
      expect(auditRow?.sourceObject, `${route.path} must be source-object centered`).toContain("workflow");
      expect(auditRow?.lifecycleStates, `${route.path} must include terminal queue lifecycle`).toContain("terminal removed");
      expect(auditRow?.denialScopeTest.length, `${route.path} must specify denial/scope story`).toBeGreaterThan(24);
      expect(auditRow?.groupScopeStory.length, `${route.path} must specify group scope story`).toBeGreaterThan(24);
      expect(auditRow?.screenshotTraceEvidence, `${route.path} must not falsely claim live screenshot/trace closure`).toContain("Pending");
      expect(route.requiredStory.length, `${route.path} must have a concrete required story`).toBeGreaterThan(48);
    }
  });

  test("records approval, evidence, planned-work, notification, and safety coverage surfaces", () => {
    expect(workflowMatrix.backendContracts.length).toBeGreaterThanOrEqual(9);
    expect(workflowMatrix.frontendContracts.length).toBeGreaterThanOrEqual(8);
    expect(workflowMatrix.requiredE2eSpecs).toContain("e2e/specs/admin-26-workflow-studio.spec.ts");
    expect(workflowMatrix.requiredE2eSpecs).toContain("e2e/specs/admin-21-work-hub.spec.ts");
    expect(workflowMatrix.requiredE2eSpecs).toContain("e2e/specs/admin-07-approvals.spec.ts");
    expect(workflowMatrix.requiredE2eSpecs).toContain("e2e/specs/mech-09-daily-plan.spec.ts");
    expect(workflowMatrix.requiredWebTests).toContain("web/src/pages/WorkflowStudioPage.test.tsx");
    expect(workflowMatrix.requiredWebTests).toContain("web/src/features/approvals/ApprovalQueue.test.tsx");
    expect(workflowMatrix.requiredBackendTests).toContain("backend/app/tests/workorder_api.rs");
    expect(workflowMatrix.safetyAssertions.join("\n")).toContain("Approval and rejection decisions require visible human comment");
    expect(workflowMatrix.safetyAssertions.join("\n")).toContain("Evidence images/files uploaded by mechanics remain viewable");
    expect(workflowMatrix.safetyAssertions.join("\n")).toContain("Urgent priority, notifications, badges");
  });

  test("keeps downstream dependencies explicit for assets, support, and finance lanes", () => {
    const auditRowsByCanonicalPath = new Map(routeAudit.routeCoverage.map((row) => [row.canonicalPath, row]));
    const auditRowsByRawPath = new Map(routeAudit.routeCoverage.map((row) => [row.rawPath ?? row.canonicalPath, row]));
    const auditForMatrixPath = (path: string) => auditRowsByRawPath.get(path) ?? auditRowsByCanonicalPath.get(path);

    for (const dependency of workflowMatrix.dependencyRoutes) {
      const auditRow = auditForMatrixPath(dependency.path);
      expect(auditRow, `${dependency.path} must exist in route audit`).toBeTruthy();
      const combined = `${auditRow?.ownerLane} ${auditRow?.sourceObject} ${auditRow?.e2eSpec} ${auditRow?.groupScopeStory}`;
      expect(combined, `${dependency.path} must declare ${dependency.expectedDependency}`).toContain(dependency.expectedDependency);
      expect(dependency.requiredStory.length, `${dependency.path} dependency story must be concrete`).toBeGreaterThan(48);
    }
  });
});
