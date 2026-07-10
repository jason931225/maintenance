// EV- evidence object surface types — UI mirror of the BE-DOCS EV contract
// (.omc/handoffs/t_15b1a1ec-ev-object-domain-api-contract.md §4/§7/§8).
// wire-pending: Phase C → GET /api/v1/evidence-objects (+ /{id}) replaces the
// stub feed in evidenceStubs.ts; these shapes already match that contract.
import type { AuditRecord } from "../audit";

/** Admissibility chip states (contract §4.7). */
export type AdmissibilityStatus =
  | "ADMISSIBLE"
  | "REVIEW_NEEDED"
  | "BLOCKED"
  | "INADMISSIBLE";

/** WORM copy verification (aligned with WormReplicaStatus). */
export type WormStatus = "PENDING" | "VERIFIED" | "FAILED";

/** TSA timestamp proof summary (contract §4.4, display subset). */
export type TsaStatus = "MISSING" | "PENDING" | "VERIFIED" | "FAILED";

/** SHA-256 fixity of the original lineage, server-derived. */
export type FixityStatus = "VERIFIED" | "PENDING" | "MISMATCH";

/** Custody ledger stages (contract §4.5, display subset + ACCESSED). */
export type CustodyStage =
  | "REGISTERED"
  | "HASH_RECORDED"
  | "TSA_VERIFIED"
  | "WORM_REPLICATED"
  | "CUSTODY_TRANSFERRED"
  | "UNDER_REVIEW"
  | "LEGAL_HOLD_APPLIED"
  | "LEGAL_HOLD_RELEASED"
  | "EXPORTED"
  | "ACCESSED"
  | "DISPOSAL_REQUESTED"
  | "DISPOSED";

export type DerivativeKind =
  | "REDACTED"
  | "THUMBNAIL"
  | "TRANSCODED"
  | "EXCERPT"
  | "EXPORT_MANIFEST"
  | "NORMALIZED_TEXT"
  | "OTHER";

/** One immutable copy row (contract §4.3). Originals never mutate. */
export interface EvidenceCopy {
  id: string;
  kind: "ORIGINAL" | "DERIVATIVE";
  derivativeKind?: DerivativeKind;
  /** Required for derivatives — lineage back to the immutable parent. */
  parentCopyId?: string;
  digestSha256: string;
  contentType: string;
  sizeBytes: number;
  wormStatus: WormStatus;
  /**
   * Set when the copy wraps a work-order evidence_media row — the REAL
   * GET /api/v1/evidence/{evidenceId}/status poll applies to this id.
   */
  sourceEvidenceMediaId?: string;
}

/** Legal hold ledger row (contract §4.6). Active hold gates disposal. */
export interface EvidenceLegalHold {
  id: string;
  caseRef: string;
  status: "ACTIVE" | "RELEASED";
  appliedAt: string;
  releasedAt?: string;
}

/** Upstream source object reference (drag-able object code + title). */
export interface EvidenceSourceRef {
  code: string;
  title: string;
}

/** The EV- object as the console renders it (list row + detail). */
export interface EvidenceObjectDetail {
  id: string;
  /** Server-issued EV- code (e.g. "EV-2026-00012"). */
  code: string;
  title: string;
  classification: string;
  admissibility: AdmissibilityStatus;
  custodyStage: CustodyStage;
  custodian: string;
  collectedAt: string;
  fixity: FixityStatus;
  tsa: TsaStatus;
  disposed: boolean;
  source?: EvidenceSourceRef;
  copies: EvidenceCopy[];
  holds: EvidenceLegalHold[];
  /** Chain-of-custody events in the audit-stream shape (reuse of AuditFeed). */
  custody: AuditRecord[];
}

/** Result of the 무결성 검증 affordance. */
export type VerifyOutcome =
  | { state: "verified"; processedAt: string | null }
  | { state: "processing" }
  | { state: "failed"; reason: string | null }
  /** No real endpoint applies to this copy yet (attestation REST wire-pending). */
  | { state: "unavailable" };

export type VerifyEvidence = (
  detail: EvidenceObjectDetail,
) => Promise<VerifyOutcome>;

// PBAC actions (deny-by-omission via PolicyGated — absent, never disabled-with-
// excuse, except the hold⇒dispose gate which is a deliberate fail-closed lock).
export const EVIDENCE_ACTIONS = {
  read: "evidence.read",
  custodyManage: "evidence.custody.manage",
  holdManage: "evidence.hold.manage",
  dispose: "evidence.dispose",
} as const;
