// Real EV- evidence REST wiring (BE2 evidence, docs-rest, openapi §11.6xx) —
// list/detail/verify/hold(apply+release). Wire-shape → domain-shape mapping
// lives here so EvidenceCard/EvidenceRecords never touch the raw payload.
import type { components } from "@maintenance/api-client-ts";

import type { ConsoleApiClient } from "../../api/client";
import { ApiCallError } from "../../api/ontologyActions";
import { ko } from "../../i18n/ko";
import type { AuditRecord } from "../audit";
import type {
  CopyVerdictMap,
  EvidenceCopy,
  EvidenceLegalHold,
  EvidenceObjectDetail,
  EvidenceSourceRef,
  FixityStatus,
  TsaStatus,
  VerifyOutcome,
} from "./types";

type EvidenceObjectView = components["schemas"]["EvidenceObjectView"];
type EvidenceObjectPage = components["schemas"]["EvidenceObjectPage"];
type EvidenceObjectDetailWire = components["schemas"]["EvidenceObjectDetail"];
type EvidenceCopyView = components["schemas"]["EvidenceCopyView"];
type CustodyEventView = components["schemas"]["CustodyEventView"];
type LegalHoldRecordView = components["schemas"]["LegalHoldRecordView"];
type TimestampAuthorityProofView = components["schemas"]["TimestampAuthorityProofView"];
type EvidenceVerifyReport = components["schemas"]["EvidenceVerifyReport"];
type EvidenceHoldRequest = components["schemas"]["EvidenceHoldRequest"];

const T = ko.console.evidence;

function mapSource(view: EvidenceObjectView): EvidenceSourceRef {
  return {
    code: view.source.source_code ?? view.source.source_id,
    title: T.sourceTypes[view.source.source_type],
  };
}

function mapCopy(view: EvidenceCopyView): EvidenceCopy {
  return {
    id: view.id,
    kind: view.copy_kind,
    derivativeKind: view.derivative_kind ?? undefined,
    parentCopyId: view.parent_copy_id ?? undefined,
    digestSha256: view.digest_sha256,
    contentType: view.content_type,
    sizeBytes: view.size_bytes,
    wormStatus: view.worm_status,
    sourceEvidenceMediaId: view.source_evidence_media_id ?? undefined,
  };
}

function mapHold(view: LegalHoldRecordView): EvidenceLegalHold {
  return {
    id: view.id,
    caseRef: view.case_ref,
    status: view.status,
    appliedAt: view.applied_at,
    releasedAt: view.released_at ?? undefined,
  };
}

/**
 * A CustodyEventView carries its stage directly (no action-string inference
 * needed) — rendered through the shared AuditRecord shape (§4-14 reuse) with
 * `action` set to the literal wire stage so custodyStageOfAudit recognizes it.
 */
function mapCustodyEvent(view: CustodyEventView): AuditRecord {
  return {
    id: view.id,
    actor: view.actor_user_id,
    action: view.stage,
    target_type: "evidence_object",
    target_id: view.evidence_object_id,
    branch_id: null,
    before_snap: view.from_custodian ?? null,
    after_snap: view.to_custodian ?? null,
    trace_id: view.audit_event_id ?? "",
    span_id: view.previous_event_id ?? "",
    occurred_at: view.occurred_at,
  };
}

/**
 * The domain model carries one aggregate TSA status; a real object may hold
 * several copy-scoped proofs. Absence renders MISSING — never faked VERIFIED.
 */
function aggregateTsa(proofs: TimestampAuthorityProofView[]): TsaStatus {
  if (proofs.length === 0) return "MISSING";
  const statuses = new Set(proofs.map((p) => p.status));
  if (statuses.has("FAILED")) return "FAILED";
  if (statuses.has("REVOKED")) return "REVOKED";
  if (statuses.has("EXPIRED_CA")) return "EXPIRED_CA";
  if (statuses.has("PENDING") || statuses.has("MISSING")) return "PENDING";
  return "VERIFIED";
}

/** Aggregate fixity across copies: any non-VERIFIED WORM copy taints the whole. */
function aggregateFixity(copies: EvidenceCopyView[]): FixityStatus {
  if (copies.some((c) => c.worm_status === "FAILED")) return "MISMATCH";
  if (copies.some((c) => c.worm_status === "PENDING")) return "PENDING";
  return "VERIFIED";
}

export function mapEvidenceObjectDetail(wire: EvidenceObjectDetailWire): EvidenceObjectDetail {
  const { object } = wire;
  return {
    id: object.id,
    code: object.code,
    title: object.title,
    classification: object.classification,
    admissibility: object.admissibility_status,
    custodyStage: object.current_custody_stage,
    // ponytail: no dedicated collected_at on the wire — created_at (registration
    // time) is the closest honest proxy, not a fabricated field.
    custodian: object.record_owner_user_id ?? object.created_by,
    collectedAt: object.created_at,
    fixity: aggregateFixity(wire.copies),
    tsa: aggregateTsa(wire.tsa_proofs),
    disposed: object.disposed_at != null,
    source: mapSource(object),
    copies: wire.copies.map(mapCopy),
    holds: wire.legal_holds.map(mapHold),
    custody: wire.custody_history.map(mapCustodyEvent),
  };
}

export function mapEvidenceObjectSummary(view: EvidenceObjectView): EvidenceObjectDetail {
  return {
    id: view.id,
    code: view.code,
    title: view.title,
    classification: view.classification,
    admissibility: view.admissibility_status,
    custodyStage: view.current_custody_stage,
    custodian: view.record_owner_user_id ?? view.created_by,
    collectedAt: view.created_at,
    // A list row carries no copies/TSA — rendered as absent/pending until the
    // row is opened and the full detail is fetched.
    fixity: "PENDING",
    tsa: "MISSING",
    disposed: view.disposed_at != null,
    source: mapSource(view),
    copies: [],
    // The list row only carries a legal_hold_state flag, not the full
    // LegalHoldRecordView[] — synthesize a status-only placeholder so
    // holdActive()/the stat bar work before the row is opened. caseRef is
    // empty here on purpose: the list row never renders it, only the fetched
    // detail (which carries the real case_ref) does.
    holds:
      view.legal_hold_state === "ACTIVE"
        ? [{ id: `${view.id}-hold`, caseRef: "", status: "ACTIVE", appliedAt: view.updated_at }]
        : [],
    custody: [],
  };
}

export async function listEvidenceObjects(
  api: ConsoleApiClient,
  limit = 200,
): Promise<EvidenceObjectDetail[]> {
  const { data, error, response } = await api.GET("/api/v1/evidence/objects", {
    params: { query: { limit } },
  });
  if (!data) throw new ApiCallError(response.status, error);
  const page: EvidenceObjectPage = data;
  return page.items.map(mapEvidenceObjectSummary);
}

export async function getEvidenceObjectDetail(
  api: ConsoleApiClient,
  id: string,
): Promise<EvidenceObjectDetail> {
  const { data, error, response } = await api.GET("/api/v1/evidence/objects/{id}", {
    params: { path: { id } },
  });
  if (!data) throw new ApiCallError(response.status, error);
  return mapEvidenceObjectDetail(data);
}

function copyVerdicts(report: EvidenceVerifyReport): CopyVerdictMap {
  return new Map(report.copies.map((copy) => [copy.copy_id, copy.status]));
}

export async function verifyEvidenceObject(
  api: ConsoleApiClient,
  id: string,
): Promise<VerifyOutcome> {
  const { data } = await api.POST("/api/v1/evidence/objects/{id}/verify", {
    params: { path: { id } },
  });
  if (!data) {
    return { state: "unavailable" };
  }
  const report: EvidenceVerifyReport = data;
  if (report.outcome === "VERIFIED") {
    return { state: "verified", processedAt: report.verified_at, copyVerdicts: copyVerdicts(report) };
  }
  const failing = report.copies.filter((c) => c.status !== "MATCH");
  const reason = failing.length > 0 ? failing.map((c) => `${c.copy_kind}:${c.status}`).join(", ") : null;
  return { state: "failed", reason, copyVerdicts: copyVerdicts(report) };
}

export async function applyLegalHold(
  api: ConsoleApiClient,
  id: string,
  body: { caseRef: string; basis: string; reason: string },
): Promise<EvidenceLegalHold> {
  const request: EvidenceHoldRequest = {
    op: "apply",
    case_ref: body.caseRef,
    basis: body.basis,
    reason: body.reason,
  };
  const { data, error, response } = await api.POST("/api/v1/evidence/objects/{id}/hold", {
    params: { path: { id } },
    body: request,
  });
  if (!data) throw new ApiCallError(response.status, error);
  return mapHold(data);
}

export async function releaseLegalHold(
  api: ConsoleApiClient,
  id: string,
  body: { holdId: string; reason: string; fourEyesRequestRef: string },
): Promise<EvidenceLegalHold> {
  const request: EvidenceHoldRequest = {
    op: "release",
    hold_id: body.holdId,
    reason: body.reason,
    four_eyes_request_ref: body.fourEyesRequestRef,
  };
  const { data, error, response } = await api.POST("/api/v1/evidence/objects/{id}/hold", {
    params: { path: { id } },
    body: request,
  });
  if (!data) throw new ApiCallError(response.status, error);
  return mapHold(data);
}

/** Open a pending four-eyes approval for a hold release. */
export async function requestHoldReleaseApproval(
  api: ConsoleApiClient,
  evidenceObjectId: string,
  holdId: string,
): Promise<{ requestRef: string; requestedBy: string }> {
  const requestRef = crypto.randomUUID();
  const { data, error, response } = await api.POST("/api/v1/governance/approvals", {
    body: {
      request_ref: requestRef,
      kind: "evidence.hold.release",
      payload_summary: { evidence_object_id: evidenceObjectId, hold_id: holdId },
    },
  });
  if (!data) throw new ApiCallError(response.status, error);
  return { requestRef: data.request_ref, requestedBy: data.requested_by };
}

/** A distinct approver decides the pending release approval. */
export async function decideHoldReleaseApproval(
  api: ConsoleApiClient,
  requestRef: string,
  requestedBy: string,
  decision: "approved" | "rejected",
): Promise<void> {
  const { data, error, response } = await api.POST("/api/v1/governance/approvals/decide", {
    body: {
      request_ref: requestRef,
      kind: "evidence.hold.release",
      requested_by: requestedBy,
      decision,
    },
  });
  if (!data) throw new ApiCallError(response.status, error);
}
