import type { components } from "@maintenance/api-client-ts";

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
type RawObligation = components["schemas"]["ComplianceObligation"];
type RawRegulation = components["schemas"]["RegulationImpact"];
type RawFramework = components["schemas"]["ComplianceFramework"];
type RawControl = components["schemas"]["ComplianceControl"];
type RawEvidence = components["schemas"]["EvidenceBinding"];

const PAGE_SIZE = 100;
/** Keeps evidence hydration responsive and bounded even for large frameworks. */
export const EVIDENCE_READ_CONCURRENCY = 6;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Compliance read was aborted", "AbortError");
}

/**
 * Walk every server-declared page.  A catalog surface must never silently turn
 * a real 101st object into an absent object simply because the first response
 * used the maximum normal page size.
 */
async function readAllPages<T>(
  signal: AbortSignal,
  readPage: (offset: number) => Promise<ApiPage<T>>,
): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  let total: number | undefined;

  do {
    throwIfAborted(signal);
    const page = await readPage(offset);
    throwIfAborted(signal);
    if (!Number.isInteger(page.total) || page.total < 0 || !Number.isInteger(page.limit) || page.limit < 1) {
      throw new Error("compliance catalog returned an invalid page boundary");
    }
    if (total === undefined) total = page.total;
    if (page.total !== total) {
      throw new Error("compliance catalog changed while paging; retry the read");
    }
    items.push(...page.items);
    offset += page.items.length;
    if (page.items.length === 0 && offset < total) {
      throw new Error("compliance catalog page ended before its declared total");
    }
  } while (offset < total);

  return items;
}

async function obligationPage(
  api: ConsoleApiClient,
  signal: AbortSignal,
  offset: number,
  query: string,
): Promise<ApiPage<RawObligation>> {
  const { data } = await api.GET("/api/v1/compliance/obligations", {
    params: { query: { limit: PAGE_SIZE, offset, ...(query ? { q: query } : {}) } },
    signal,
  });
  if (!data) throw new Error("compliance obligations read returned no data");
  return data;
}

async function regulationPage(
  api: ConsoleApiClient,
  signal: AbortSignal,
  offset: number,
  query: string,
): Promise<ApiPage<RawRegulation>> {
  const { data } = await api.GET("/api/v1/compliance/regulations", {
    params: { query: { limit: PAGE_SIZE, offset, ...(query ? { q: query } : {}) } },
    signal,
  });
  if (!data) throw new Error("compliance regulations read returned no data");
  return data;
}

async function frameworkPage(
  api: ConsoleApiClient,
  signal: AbortSignal,
  offset: number,
  query: string,
): Promise<ApiPage<RawFramework>> {
  const { data } = await api.GET("/api/v1/compliance/frameworks", {
    params: { query: { limit: PAGE_SIZE, offset, ...(query ? { q: query } : {}) } },
    signal,
  });
  if (!data) throw new Error("compliance frameworks read returned no data");
  return data;
}

async function controlPage(
  api: ConsoleApiClient,
  signal: AbortSignal,
  frameworkId: string,
  offset: number,
): Promise<ApiPage<RawControl>> {
  const { data } = await api.GET("/api/v1/compliance/framework-controls", {
    params: { query: { framework_id: frameworkId, limit: PAGE_SIZE, offset } },
    signal,
  });
  if (!data) throw new Error("compliance framework controls read returned no data");
  return data;
}

async function evidencePage(
  api: ConsoleApiClient,
  signal: AbortSignal,
  controlId: string,
  offset: number,
): Promise<ApiPage<RawEvidence>> {
  const { data } = await api.GET("/api/v1/compliance/evidence-bindings", {
    params: { query: { control_id: controlId, limit: PAGE_SIZE, offset } },
    signal,
  });
  if (!data) throw new Error("compliance evidence bindings read returned no data");
  return data;
}

function normalizedQuery(query: string): string {
  return query.trim();
}

function obligation(raw: RawObligation): ComplianceObligation {
  return {
    kind: "obligation", id: raw.id, code: raw.code, title: raw.title, description: raw.description,
    obligationType: raw.obligation_type, scopeKind: raw.scope.kind,
    scope: {
      kind: raw.scope.kind,
      scopeRef: raw.scope.scope_ref ?? undefined,
      branchId: raw.scope.branch_id ?? undefined,
      siteId: raw.scope.site_id ?? undefined,
    },
    ownerUserId: raw.owner_user_id ?? undefined, severity: raw.severity, status: raw.status,
    effectiveFrom: raw.effective_from ?? undefined, effectiveTo: raw.effective_to ?? undefined,
    reviewCadence: raw.review_cadence ?? undefined, nextReviewOn: raw.next_review_on ?? undefined,
    metadata: raw.metadata, createdBy: raw.created_by, updatedBy: raw.updated_by,
    createdAt: raw.created_at, updatedAt: raw.updated_at,
  };
}

function regulation(raw: RawRegulation): RegulationImpact {
  return {
    kind: "regulation", id: raw.id, code: raw.code, title: raw.title, jurisdiction: raw.jurisdiction,
    regulator: raw.regulator ?? undefined, citation: raw.citation, sourceUrl: raw.source_url ?? undefined,
    impactArea: raw.impact_area, impactSummary: raw.impact_summary, riskLevel: raw.risk_level,
    status: raw.status, effectiveFrom: raw.effective_from ?? undefined, effectiveTo: raw.effective_to ?? undefined,
    reviewDueOn: raw.review_due_on ?? undefined, ownerUserId: raw.owner_user_id ?? undefined,
    metadata: raw.metadata, createdBy: raw.created_by, updatedBy: raw.updated_by,
    createdAt: raw.created_at, updatedAt: raw.updated_at,
  };
}

function framework(raw: RawFramework, controls: ComplianceControl[] = []): ComplianceFramework {
  return {
    kind: "framework", id: raw.id, code: raw.code, title: raw.name, versionLabel: raw.version_label,
    frameworkKind: raw.framework_kind, status: raw.status, ownerUserId: raw.owner_user_id ?? undefined,
    effectiveFrom: raw.effective_from ?? undefined, effectiveTo: raw.effective_to ?? undefined,
    metadata: raw.metadata, createdBy: raw.created_by, updatedBy: raw.updated_by,
    createdAt: raw.created_at, updatedAt: raw.updated_at, controls,
  };
}

function evidence(raw: RawEvidence): EvidenceBinding {
  return {
    id: raw.id, controlId: raw.control_id, obligationId: raw.obligation_id ?? undefined,
    evidenceTargetType: raw.evidence_target_type, evidenceTargetId: raw.evidence_target_id,
    sourceAuditEventId: raw.source_audit_event_id ?? undefined, status: raw.status, confidence: raw.confidence,
    collectedAt: raw.collected_at ?? undefined, collectedBy: raw.collected_by ?? undefined,
    validFrom: raw.valid_from ?? undefined, validTo: raw.valid_to ?? undefined, hashSha256: raw.hash_sha256 ?? undefined,
    metadata: raw.metadata, createdBy: raw.created_by, updatedBy: raw.updated_by,
    createdAt: raw.created_at, updatedAt: raw.updated_at,
  };
}

function control(raw: RawControl, evidenceBindings: EvidenceBinding[]): ComplianceControl {
  return {
    id: raw.id, frameworkId: raw.framework_id, controlKey: raw.control_key, title: raw.title,
    objective: raw.objective, controlType: raw.control_type, cadence: raw.cadence,
    status: raw.status, evidenceRequirements: raw.evidence_requirements,
    ownerUserId: raw.owner_user_id ?? undefined, createdBy: raw.created_by, updatedBy: raw.updated_by,
    createdAt: raw.created_at, updatedAt: raw.updated_at, evidenceBindings,
  };
}

export async function readComplianceCatalog(
  api: ConsoleApiClient,
  query: string,
  readable: { obligations: boolean; regulations: boolean; frameworks: boolean },
  signal: AbortSignal,
): Promise<ComplianceCatalogItem[]> {
  const q = normalizedQuery(query);
  const [obligations, regulations, frameworks] = await Promise.all([
    readable.obligations ? readAllPages(signal, (offset) => obligationPage(api, signal, offset, q)) : Promise.resolve([] as RawObligation[]),
    readable.regulations ? readAllPages(signal, (offset) => regulationPage(api, signal, offset, q)) : Promise.resolve([] as RawRegulation[]),
    readable.frameworks ? readAllPages(signal, (offset) => frameworkPage(api, signal, offset, q)) : Promise.resolve([] as RawFramework[]),
  ]);
  return [...obligations.map(obligation), ...regulations.map(regulation), ...frameworks.map((item) => framework(item))];
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  signal: AbortSignal,
  limit: number,
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      throwIfAborted(signal);
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await work(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

export async function readFrameworkDetail(
  api: ConsoleApiClient,
  frameworkRow: ComplianceFramework,
  signal: AbortSignal,
): Promise<ComplianceFramework> {
  const rawControls = await readAllPages(signal, (offset) => controlPage(api, signal, frameworkRow.id, offset));
  const controlsWithEvidence = await mapWithConcurrency(
    rawControls,
    signal,
    EVIDENCE_READ_CONCURRENCY,
    async (rawControl) => {
      const bindings = await readAllPages(signal, (offset) => evidencePage(api, signal, rawControl.id, offset));
      return control(rawControl, bindings.map(evidence));
    },
  );
  return { ...frameworkRow, controls: controlsWithEvidence };
}

export function kindForRowId(items: ComplianceCatalogItem[], id: string): ComplianceCatalogItem | undefined {
  return items.find((item) => item.id === id);
}
