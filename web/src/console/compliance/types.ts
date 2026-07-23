// CP-/RG-/FW- compliance surface types mirror the authenticated compliance REST
// domain. They intentionally retain server identities, scope, provenance, and
// evidence metadata: presentation must never replace those facts with labels or
// local fixture data.
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
  scope: { kind: ComplianceScopeKind; scopeRef?: string; branchId?: string; siteId?: string };
  ownerName?: string;
  ownerUserId?: string;
  severity: ComplianceRiskLevel;
  status: ObligationStatus;
  effectiveFrom?: string;
  effectiveTo?: string;
  reviewCadence?: ReviewCadence;
  nextReviewOn?: string;
  updatedAt: string;
  metadata: unknown;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
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
  ownerUserId?: string;
  updatedAt: string;
  metadata: unknown;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
}

export interface ComplianceControl {
  id: string;
  frameworkId: string;
  controlKey: string;
  title: string;
  objective: string;
  controlType: string;
  cadence?: string | null;
  status: ControlStatus;
  evidenceRequirements: unknown;
  ownerUserId?: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  evidenceBindings: EvidenceBinding[];
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
  ownerUserId?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  updatedAt: string;
  metadata: unknown;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  controls: ComplianceControl[];
}

export interface EvidenceBinding {
  id: string;
  controlId: string;
  obligationId?: string;
  evidenceTargetType: string;
  evidenceTargetId: string;
  sourceAuditEventId?: string;
  status: EvidenceBindingStatus;
  confidence: string;
  collectedAt?: string;
  collectedBy?: string;
  validFrom?: string;
  validTo?: string;
  hashSha256?: string;
  metadata: unknown;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export type ComplianceCatalogItem = ComplianceObligation | RegulationImpact | ComplianceFramework;
