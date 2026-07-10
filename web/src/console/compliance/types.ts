// CP-/RG-/FW- compliance surface types — UI mirror of the BE compliance
// domain FSMs (backend/crates/compliance/domain/src/lib.rs: ObligationStatus,
// RegulationImpactStatus, FrameworkStatus, ControlStatus, EvidenceBindingStatus
// + the compliance_enum! wire strings). No REST/openapi exists for these
// objects yet (0 refs — ontology-coverage-matrix.md item 6); every read here
// is wire-pending until BE-OBJ ships mnt_compliance_rest obligation/regulation/
// framework/control/evidence routes + an openapi.yaml fragment + client regen.
export type ObligationStatus = "DRAFT" | "ACTIVE" | "WAIVED" | "SUPERSEDED" | "ARCHIVED";
export type RegulationImpactStatus = "DRAFT" | "ACTIVE" | "SUPERSEDED" | "ARCHIVED";
export type FrameworkStatus = "DRAFT" | "ACTIVE" | "RETIRED" | "ARCHIVED";
export type ControlStatus = "DRAFT" | "ACTIVE" | "RETIRED" | "ARCHIVED";
export type EvidenceBindingStatus = "PROPOSED" | "ACCEPTED" | "REJECTED" | "EXPIRED" | "RETRACTED";

export type ComplianceRiskLevel = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type ObligationType = "LEGAL" | "REGULATORY" | "CONTRACTUAL" | "INTERNAL_POLICY" | "CONTROL_REQUIREMENT";
export type ComplianceScopeKind = "ORG" | "BRANCH" | "SITE" | "TEAM" | "ROLE";
export type ReviewCadence = "MONTHLY" | "QUARTERLY" | "SEMI_ANNUAL" | "ANNUAL" | "EVENT_DRIVEN";
export type FrameworkKind =
  | "LEGAL_BASELINE"
  | "INTERNAL_CONTROL"
  | "CUSTOMER_CONTROL"
  | "SECURITY_STANDARD"
  | "SAFETY_STANDARD"
  | "AUDIT_PROGRAM";
export type CoverageLevel = "PRIMARY" | "PARTIAL" | "SUPPORTING" | "COMPENSATING";
export type CoverageStatus = "ACTIVE" | "RETIRED";

/** Discriminates the three catalog objects sharing this module surface. */
export type ComplianceObjectKind = "obligation" | "regulation" | "framework";

export interface ComplianceObligation {
  kind: "obligation";
  id: string;
  code: string;
  title: string;
  description: string;
  obligationType: ObligationType;
  scopeKind: ComplianceScopeKind;
  ownerName?: string;
  severity: ComplianceRiskLevel;
  status: ObligationStatus;
  effectiveFrom?: string;
  effectiveTo?: string;
  reviewCadence?: ReviewCadence;
  nextReviewOn?: string;
  updatedAt: string;
}

export interface RegulationImpact {
  kind: "regulation";
  id: string;
  code: string;
  title: string;
  jurisdiction: string;
  regulator?: string;
  citation: string;
  sourceUrl?: string;
  impactArea: string;
  impactSummary: string;
  riskLevel: ComplianceRiskLevel;
  status: RegulationImpactStatus;
  effectiveFrom?: string;
  effectiveTo?: string;
  reviewDueOn?: string;
  ownerName?: string;
  updatedAt: string;
}

export interface ComplianceControl {
  id: string;
  frameworkId: string;
  controlKey: string;
  title: string;
  objective: string;
  status: ControlStatus;
  coverageLevel: CoverageLevel;
  coverageStatus: CoverageStatus;
  evidenceStatus: EvidenceBindingStatus;
  evidenceCount: number;
}

export interface ComplianceFramework {
  kind: "framework";
  id: string;
  code: string;
  title: string;
  versionLabel: string;
  frameworkKind: FrameworkKind;
  status: FrameworkStatus;
  ownerName?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  updatedAt: string;
  controls: ComplianceControl[];
}

export type ComplianceCatalogItem = ComplianceObligation | RegulationImpact | ComplianceFramework;
