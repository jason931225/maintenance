import type { ConsoleApiClient } from "../../api/client";

import type {
  ComplianceCatalogItem,
  ComplianceControl,
  ComplianceFramework,
  ComplianceObligation,
  EvidenceBinding,
  RegulationImpact,
} from "./types";

type ApiPage<T> = { items: T[]; limit: number; offset: number; total: number };

type RawScope = {
  scope_type: ComplianceObligation["scopeKind"];
  scope_ref: string | null;
  branch_id: string | null;
  site_id: string | null;
};

type RawObligation = Omit<ComplianceObligation, "kind" | "scopeKind" | "ownerName" | "updatedAt" | "effectiveFrom" | "effectiveTo" | "reviewCadence" | "nextReviewOn" | "ownerUserId" | "scope" | "metadata" | "createdBy" | "updatedBy" | "createdAt"> & {
  obligation_type: ComplianceObligation["obligationType"];
  owner_user_id: string | null;
  scope: RawScope;
  effective_from: string | null;
  effective_to: string | null;
  review_cadence: ComplianceObligation["reviewCadence"] | null;
  next_review_on: string | null;
  metadata: unknown;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
};

type RawRegulation = {
  id: string; code: string; title: string; jurisdiction: string; regulator?: string; citation: string;
  source_url?: string; impact_area: string; impact_summary: string; risk_level: RegulationImpact["riskLevel"]; status: RegulationImpact["status"];
  owner_user_id: string | null;
  effective_from: string | null;
  effective_to: string | null;
  review_due_on: string | null;
  metadata: unknown;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
};

type RawFramework = {
  id: string; code: string; name: string; version_label: string; framework_kind: ComplianceFramework["frameworkKind"]; status: ComplianceFramework["status"];
  owner_user_id: string | null;
  effective_from: string | null;
  effective_to: string | null;
  metadata: unknown;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
};

type RawControl = {
  id: string; framework_id: string; control_key: string; title: string; objective: string; cadence?: string | null; status: ComplianceControl["status"];
  control_type: string;
  evidence_requirements: unknown;
  owner_user_id: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
};

type RawEvidence = {
  id: string; control_id: string; obligation_id?: string | null; evidence_target_type: string; evidence_target_id: string;
  status: EvidenceBinding["status"]; confidence: string; metadata: unknown;
  source_audit_event_id: string | null;
  collected_at: string | null;
  collected_by: string | null;
  valid_from: string | null;
  valid_to: string | null;
  hash_sha256: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
};

type UntypedGet = <T>(path: string, init: { params: { query: Record<string, string | number | undefined> } }) => Promise<{ data?: T }>;

function readApi<T>(api: ConsoleApiClient, path: string, query: Record<string, string | number | undefined>): Promise<T> {
  const get = api.GET as unknown as UntypedGet;
  return get<T>(path, { params: { query } }).then((response) => {
    if (!response.data) throw new Error(`compliance read returned no data: ${path}`);
    return response.data;
  });
}

function pageQuery(query?: string): Record<string, string | number | undefined> {
  return { limit: 100, offset: 0, ...(query?.trim() ? { q: query.trim() } : {}) };
}

function obligation(raw: RawObligation): ComplianceObligation {
  return {
    kind: "obligation", id: raw.id, code: raw.code, title: raw.title, description: raw.description,
    obligationType: raw.obligation_type, scopeKind: raw.scope.scope_type, scope: raw.scope, ownerUserId: raw.owner_user_id ?? undefined,
    severity: raw.severity, status: raw.status, effectiveFrom: raw.effective_from ?? undefined, effectiveTo: raw.effective_to ?? undefined,
    reviewCadence: raw.review_cadence ?? undefined, nextReviewOn: raw.next_review_on ?? undefined, metadata: raw.metadata,
    createdBy: raw.created_by, updatedBy: raw.updated_by, createdAt: raw.created_at, updatedAt: raw.updated_at,
  };
}

function regulation(raw: RawRegulation): RegulationImpact {
  return {
    kind: "regulation", id: raw.id, code: raw.code, title: raw.title, jurisdiction: raw.jurisdiction, regulator: raw.regulator,
    citation: raw.citation, sourceUrl: raw.source_url, impactArea: raw.impact_area, impactSummary: raw.impact_summary,
    riskLevel: raw.risk_level, status: raw.status, effectiveFrom: raw.effective_from ?? undefined, effectiveTo: raw.effective_to ?? undefined,
    reviewDueOn: raw.review_due_on ?? undefined, ownerUserId: raw.owner_user_id ?? undefined, metadata: raw.metadata,
    createdBy: raw.created_by, updatedBy: raw.updated_by, createdAt: raw.created_at, updatedAt: raw.updated_at,
  };
}

function framework(raw: RawFramework, controls: ComplianceControl[] = []): ComplianceFramework {
  return {
    kind: "framework", id: raw.id, code: raw.code, title: raw.name, versionLabel: raw.version_label, frameworkKind: raw.framework_kind,
    status: raw.status, ownerUserId: raw.owner_user_id ?? undefined, effectiveFrom: raw.effective_from ?? undefined,
    effectiveTo: raw.effective_to ?? undefined, metadata: raw.metadata, createdBy: raw.created_by, updatedBy: raw.updated_by,
    createdAt: raw.created_at, updatedAt: raw.updated_at, controls,
  };
}

function evidence(raw: RawEvidence): EvidenceBinding {
  return {
    id: raw.id, controlId: raw.control_id, obligationId: raw.obligation_id ?? undefined, evidenceTargetType: raw.evidence_target_type,
    evidenceTargetId: raw.evidence_target_id, sourceAuditEventId: raw.source_audit_event_id ?? undefined, status: raw.status,
    confidence: raw.confidence, collectedAt: raw.collected_at ?? undefined, collectedBy: raw.collected_by ?? undefined,
    validFrom: raw.valid_from ?? undefined, validTo: raw.valid_to ?? undefined, hashSha256: raw.hash_sha256 ?? undefined,
    metadata: raw.metadata, createdBy: raw.created_by, updatedBy: raw.updated_by, createdAt: raw.created_at, updatedAt: raw.updated_at,
  };
}

function control(raw: RawControl, evidenceBindings: EvidenceBinding[]): ComplianceControl {
  return {
    id: raw.id, frameworkId: raw.framework_id, controlKey: raw.control_key, title: raw.title, objective: raw.objective,
    controlType: raw.control_type, cadence: raw.cadence, status: raw.status, evidenceRequirements: raw.evidence_requirements,
    ownerUserId: raw.owner_user_id ?? undefined, createdBy: raw.created_by, updatedBy: raw.updated_by,
    createdAt: raw.created_at, updatedAt: raw.updated_at, evidenceBindings,
  };
}

export async function readComplianceCatalog(
  api: ConsoleApiClient,
  query: string,
  readable: { obligations: boolean; regulations: boolean; frameworks: boolean },
): Promise<ComplianceCatalogItem[]> {
  const params = pageQuery(query);
  const [obligations, regulations, frameworks] = await Promise.all([
    readable.obligations ? readApi<ApiPage<RawObligation>>(api, "/api/v1/compliance/obligations", params) : Promise.resolve({ items: [] as RawObligation[] }),
    readable.regulations ? readApi<ApiPage<RawRegulation>>(api, "/api/v1/compliance/regulations", params) : Promise.resolve({ items: [] as RawRegulation[] }),
    readable.frameworks ? readApi<ApiPage<RawFramework>>(api, "/api/v1/compliance/frameworks", params) : Promise.resolve({ items: [] as RawFramework[] }),
  ]);
  return [...obligations.items.map(obligation), ...regulations.items.map(regulation), ...frameworks.items.map((item) => framework(item))];
}

export async function readFrameworkDetail(api: ConsoleApiClient, frameworkRow: ComplianceFramework): Promise<ComplianceFramework> {
  const controls = await readApi<ApiPage<RawControl>>(api, "/api/v1/compliance/framework-controls", {
    ...pageQuery(), framework_id: frameworkRow.id,
  });
  const controlsWithEvidence = await Promise.all(
    controls.items.map(async (rawControl) => {
      const bindings = await readApi<ApiPage<RawEvidence>>(api, "/api/v1/compliance/evidence-bindings", {
        ...pageQuery(), control_id: rawControl.id,
      });
      return control(rawControl, bindings.items.map(evidence));
    }),
  );
  return { ...frameworkRow, controls: controlsWithEvidence };
}

export function kindForRowId(items: ComplianceCatalogItem[], id: string): ComplianceCatalogItem | undefined {
  return items.find((item) => item.id === id);
}
