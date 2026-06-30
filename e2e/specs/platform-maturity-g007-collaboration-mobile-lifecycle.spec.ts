import { test, expect } from "@playwright/test";

import collaborationMatrix from "../../docs/benchmarks/g007-collaboration-mobile-lifecycle-matrix.json" with { type: "json" };
import routeAudit from "../../docs/benchmarks/enterprise-ui-route-audit.json" with { type: "json" };

const GOAL_ID = "G007-collaboration-mail-calendar-poll-mob";

test.describe("G007 collaboration/mail/calendar/poll/mobile lifecycle contract", () => {
  test("maps every G007 route to collaboration browser/mobile stories without claiming live closure", () => {
    expect(collaborationMatrix.goalId).toBe(GOAL_ID);
    expect(collaborationMatrix.nonClaimPolicy).toContain("G009");

    const matrixRoutes = new Map(collaborationMatrix.routePaths.map((row) => [row.path, row]));
    const auditRows = new Map(routeAudit.routeCoverage.map((row) => [row.canonicalPath, row]));
    const g007AuditRows = routeAudit.routeCoverage.filter((row) => row.ownerLane.startsWith("G007"));

    expect(g007AuditRows.length).toBe(collaborationMatrix.routePaths.length);
    expect(g007AuditRows.length).toBeGreaterThanOrEqual(3);
    for (const auditRow of g007AuditRows) {
      expect(matrixRoutes.has(auditRow.canonicalPath), `${auditRow.canonicalPath} must be in G007 matrix`).toBeTruthy();
    }

    for (const route of collaborationMatrix.routePaths) {
      const auditRow = auditRows.get(route.path);
      expect(auditRow, `${route.path} must exist in route audit`).toBeTruthy();
      expect(auditRow?.ownerLane, `${route.path} must be G007-owned`).toContain("G007");
      expect(auditRow?.e2eSpec, `${route.path} must require browser/mobile story`).toContain("Required browser/mobile");
      expect(auditRow?.sourceObject, `${route.path} must include collaboration source object`).toContain("conversation");
      expect(auditRow?.lifecycleStates, `${route.path} must include unread/read lifecycle`).toContain("unread");
      expect(auditRow?.denialScopeTest, `${route.path} must deny private/shared collaboration leakage`).toContain("Private thread");
      expect(auditRow?.groupScopeStory, `${route.path} must preserve group/subsidiary scope`).toContain("Group and subsidiary");
      expect(auditRow?.screenshotTraceEvidence, `${route.path} must not falsely claim live screenshot/trace closure`).toContain("Pending");
      expect(route.requiredStory.length, `${route.path} must have a concrete required story`).toBeGreaterThan(72);
    }
  });

  test("records messenger, mail, calendar, poll, notification, and native mobile evidence surfaces", () => {
    expect(collaborationMatrix.backendContracts.length).toBeGreaterThanOrEqual(12);
    expect(collaborationMatrix.frontendContracts.length).toBeGreaterThanOrEqual(9);
    expect(collaborationMatrix.mobileContracts.length).toBeGreaterThanOrEqual(8);
    expect(collaborationMatrix.requiredE2eSpecs).toContain("e2e/specs/mech-11-messenger.spec.ts");
    expect(collaborationMatrix.requiredE2eSpecs).toContain("e2e/specs/admin-21-work-hub.spec.ts");
    expect(collaborationMatrix.requiredWebTests).toContain("web/src/pages/CollaborationPage.test.tsx");
    expect(collaborationMatrix.requiredWebTests).toContain("web/src/pages/MailPage.test.tsx");
    expect(collaborationMatrix.requiredWebTests).toContain("web/src/features/messenger/MessengerPanel.test.tsx");
    expect(collaborationMatrix.requiredBackendTests).toContain("backend/crates/messenger/rest/tests/api.rs");
    expect(collaborationMatrix.requiredBackendTests).toContain("backend/crates/comms/adapter-postgres/tests/mail_sync_rls_surfaces_as_runtime_role.rs");
    expect(collaborationMatrix.requiredMobileTests).toContain("ios/UITests/MessengerUITests.swift");
    expect(collaborationMatrix.requiredMobileTests).toContain("android/app/src/test/kotlin/com/maintenance/field/data/collaboration/MobileOperationsRepositoryTest.kt");

    const assertions = collaborationMatrix.safetyAssertions.join("\n");
    expect(assertions).toContain("Messenger Enter sends only plain Enter");
    expect(assertions).toContain("Latest sent/received message must scroll/focus");
    expect(assertions).toContain("Mail HTML must be sanitized");
    expect(assertions).toContain("Mobile approval and poll vote actions require passkey step-up");
    expect(assertions).toContain("Live SMTP/IMAP/push/mobile production rollout must not be claimed before G009");
  });

  test("keeps Work Hub and approval dependencies explicit", () => {
    const auditRows = new Map(routeAudit.routeCoverage.map((row) => [row.canonicalPath, row]));

    for (const dependency of collaborationMatrix.dependencyRoutes) {
      const auditRow = auditRows.get(dependency.path);
      expect(auditRow, `${dependency.path} must exist in route audit`).toBeTruthy();
      const combined = `${auditRow?.ownerLane} ${auditRow?.sourceObject} ${auditRow?.e2eSpec} ${auditRow?.groupScopeStory}`;
      expect(combined, `${dependency.path} must declare ${dependency.expectedDependency}`).toContain(dependency.expectedDependency);
      expect(dependency.requiredStory.length, `${dependency.path} dependency story must be concrete`).toBeGreaterThan(72);
    }
  });
});
