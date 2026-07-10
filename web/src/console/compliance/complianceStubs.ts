// wire-pending: W1-FE-compliance-ui GET /api/v1/compliance/obligations,
// GET /api/v1/compliance/regulations, GET /api/v1/compliance/frameworks
// (+ /{id}/controls, /{id}/evidence-bindings) — proposed REST shape mirroring
// mnt_compliance_domain structs; no route/openapi fragment exists today (only
// the unrelated location-consent FSM is wired under mnt_compliance_rest). This
// factory stands in with the same field shapes so wiring = replacing the
// factory with the fetch, not rewriting the surface.
//
// Sample content routes through ko.console.modules.compliance.samples (the
// serial i18n wire-up merged the koManifest), mirroring the evidenceStubs.ts
// pattern (S = ko.console.evidence.samples).
import { ko } from "../../i18n/ko";
import type { ComplianceCatalogItem, ComplianceControl, ComplianceFramework, ComplianceObligation, RegulationImpact } from "./types";

const S = ko.console.modules.compliance.samples;

function control(
  id: string,
  frameworkId: string,
  controlKey: string,
  title: string,
  objective: string,
  coverageLevel: ComplianceControl["coverageLevel"],
  evidenceStatus: ComplianceControl["evidenceStatus"],
  evidenceCount: number,
): ComplianceControl {
  return {
    id,
    frameworkId,
    controlKey,
    title,
    objective,
    status: "ACTIVE",
    coverageLevel,
    coverageStatus: "ACTIVE",
    evidenceStatus,
    evidenceCount,
  };
}

export function createObligationStubs(): ComplianceObligation[] {
  return [
    {
      kind: "obligation",
      id: "cp-0001",
      code: "CP-0001",
      title: S.obligations.cp0001.title,
      description: S.obligations.cp0001.description,
      obligationType: "LEGAL",
      scopeKind: "ORG",
      ownerName: S.obligations.cp0001.owner,
      severity: "HIGH",
      status: "ACTIVE",
      effectiveFrom: "2026-01-01",
      reviewCadence: "ANNUAL",
      nextReviewOn: "2026-12-01",
      updatedAt: "2026-07-08T09:00:00+09:00",
    },
    {
      kind: "obligation",
      id: "cp-0002",
      code: "CP-0002",
      title: S.obligations.cp0002.title,
      description: S.obligations.cp0002.description,
      obligationType: "REGULATORY",
      scopeKind: "BRANCH",
      ownerName: S.obligations.cp0002.owner,
      severity: "CRITICAL",
      status: "WAIVED",
      effectiveFrom: "2026-01-01",
      reviewCadence: "QUARTERLY",
      nextReviewOn: "2026-09-01",
      updatedAt: "2026-06-30T14:20:00+09:00",
    },
    {
      kind: "obligation",
      id: "cp-0003",
      code: "CP-0003",
      title: S.obligations.cp0003.title,
      description: S.obligations.cp0003.description,
      obligationType: "REGULATORY",
      scopeKind: "ORG",
      ownerName: S.obligations.cp0003.owner,
      severity: "HIGH",
      status: "ACTIVE",
      effectiveFrom: "2025-09-15",
      reviewCadence: "SEMI_ANNUAL",
      nextReviewOn: "2026-09-15",
      updatedAt: "2026-07-01T11:05:00+09:00",
    },
  ];
}

export function createRegulationStubs(): RegulationImpact[] {
  return [
    {
      kind: "regulation",
      id: "rg-0001",
      code: "RG-0001",
      title: S.regulations.rg0001.title,
      jurisdiction: S.regulations.rg0001.jurisdiction,
      regulator: S.regulations.rg0001.regulator,
      citation: S.regulations.rg0001.citation,
      impactArea: S.regulations.rg0001.impactArea,
      impactSummary: S.regulations.rg0001.impactSummary,
      riskLevel: "HIGH",
      status: "ACTIVE",
      effectiveFrom: "2026-01-01",
      reviewDueOn: "2026-12-01",
      ownerName: S.regulations.rg0001.owner,
      updatedAt: "2026-07-05T10:00:00+09:00",
    },
    {
      kind: "regulation",
      id: "rg-0002",
      code: "RG-0002",
      title: S.regulations.rg0002.title,
      jurisdiction: S.regulations.rg0002.jurisdiction,
      regulator: S.regulations.rg0002.regulator,
      citation: S.regulations.rg0002.citation,
      impactArea: S.regulations.rg0002.impactArea,
      impactSummary: S.regulations.rg0002.impactSummary,
      riskLevel: "CRITICAL",
      status: "SUPERSEDED",
      effectiveFrom: "2021-07-01",
      effectiveTo: "2026-01-01",
      ownerName: S.regulations.rg0002.owner,
      updatedAt: "2026-01-01T00:00:00+09:00",
    },
  ];
}

export function createFrameworkStubs(): ComplianceFramework[] {
  const isms: ComplianceFramework = {
    kind: "framework",
    id: "fw-0001",
    code: "FW-0001",
    title: S.frameworks.fw0001.title,
    versionLabel: "2026.1",
    frameworkKind: "SECURITY_STANDARD",
    status: "ACTIVE",
    ownerName: S.frameworks.fw0001.owner,
    effectiveFrom: "2026-03-01",
    updatedAt: "2026-07-02T08:30:00+09:00",
    controls: [
      control("fw-0001-c1", "fw-0001", "ISMS-2.5.1", S.frameworks.fw0001.controls.c1.title, S.frameworks.fw0001.controls.c1.objective, "PRIMARY", "ACCEPTED", 3),
      control("fw-0001-c2", "fw-0001", "ISMS-2.9.4", S.frameworks.fw0001.controls.c2.title, S.frameworks.fw0001.controls.c2.objective, "PRIMARY", "PROPOSED", 1),
      control("fw-0001-c3", "fw-0001", "ISMS-2.10.2", S.frameworks.fw0001.controls.c3.title, S.frameworks.fw0001.controls.c3.objective, "SUPPORTING", "REJECTED", 0),
    ],
  };
  const safety: ComplianceFramework = {
    kind: "framework",
    id: "fw-0002",
    code: "FW-0002",
    title: S.frameworks.fw0002.title,
    versionLabel: "1.3",
    frameworkKind: "SAFETY_STANDARD",
    status: "DRAFT",
    ownerName: S.frameworks.fw0002.owner,
    updatedAt: "2026-06-20T16:10:00+09:00",
    controls: [
      control("fw-0002-c1", "fw-0002", "SAFE-3.1", S.frameworks.fw0002.controls.c1.title, S.frameworks.fw0002.controls.c1.objective, "PRIMARY", "ACCEPTED", 2),
    ],
  };
  return [isms, safety];
}

export function createComplianceCatalogStubs(): ComplianceCatalogItem[] {
  return [...createObligationStubs(), ...createRegulationStubs(), ...createFrameworkStubs()];
}
