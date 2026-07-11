// EV- evidence object surface types — UI mirror of the BE-DOCS EV contract
// (.omc/handoffs/t_15b1a1ec-ev-object-domain-api-contract.md §4/§7/§8).
// Real-wired: evidenceApi.ts maps GET /api/v1/evidence/objects (+ /{id}) into
// these shapes. evidenceFixtures.ts (test-only) mirrors the same contract.
import type { AuditRecord } from "../audit";

/** Admissibility chip states (contract §4.7). */
export type AdmissibilityStatus =
  | "ADMISSIBLE"
  | "REVIEW_NEEDED"
  | "BLOCKED"
  | "INADMISSIBLE";

/** WORM copy verification (aligned with WormReplicaStatus). */
export type WormStatus = "PENDING" | "VERIFIED" | "FAILED";

/** TSA timestamp proof summary — mirrors the wire TsaProofStatus exactly (no
 * faked upgrade to VERIFIED; a null/absent proof renders as MISSING). */
export type TsaStatus =
  | "MISSING"
  | "PENDING"
  | "VERIFIED"
  | "FAILED"
  | "REVOKED"
  | "EXPIRED_CA";

/** SHA-256 fixity of the original lineage, server-derived. */
export type FixityStatus = "VERIFIED" | "PENDING" | "MISMATCH";

/**
 * Custody ledger stages — mirrors the wire CustodyStage enum exactly, plus
 * ACCESSED which is a client-side synthesis for read/view-shaped audit
 * actions (no such wire stage exists; see custodyStageOfAudit).
 */
export type CustodyStage =
  | "REGISTERED"
  | "HASH_RECORDED"
  | "TSA_SUBMITTED"
  | "TSA_VERIFIED"
  | "WORM_REPLICATED"
  | "CUSTODY_TRANSFERRED"
  | "UNDER_REVIEW"
  | "ADMISSIBILITY_EVALUATED"
  | "LEGAL_HOLD_APPLIED"
  | "LEGAL_HOLD_RELEASED"
  | "EXPORTED"
  | "ARCHIVED"
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
  /** Object registration time (wire created_at) — labeled 등록 시각, not a
   * chain-of-custody collection timestamp (which the wire does not carry). */
  registeredAt: string;
  fixity: FixityStatus;
  tsa: TsaStatus;
  disposed: boolean;
  source?: EvidenceSourceRef;
  copies: EvidenceCopy[];
  holds: EvidenceLegalHold[];
  /** Chain-of-custody events in the audit-stream shape (reuse of AuditFeed). */
  custody: AuditRecord[];
}

/** Per-copy fixity verdict (contract §7.8 CopyVerification), keyed by copy id.
 * A Map (not Record) so a missing key types as `undefined` without relying on
 * noUncheckedIndexedAccess. */
export type CopyFixityStatus = "MATCH" | "MISMATCH" | "CHECKSUM_UNAVAILABLE" | "STORAGE_ERROR";
export type CopyVerdictMap = ReadonlyMap<string, CopyFixityStatus>;

/** Result of the 무결성 검증 affordance. */
export type VerifyOutcome =
  | { state: "verified"; processedAt: string | null; copyVerdicts: CopyVerdictMap }
  | { state: "processing" }
  | { state: "failed"; reason: string | null; copyVerdicts: CopyVerdictMap }
  /** Object storage not configured (503) or the request failed outright. */
  | { state: "unavailable" };

export type VerifyEvidence = (
  detail: EvidenceObjectDetail,
) => Promise<VerifyOutcome>;

/**
 * Hold-release four-eyes state (contract: hold-release requires a distinct-
 * approver approval opened via governance/approvals then decided via
 * governance/approvals/decide before the actual release call can succeed —
 * fail-closed: the hold stays ACTIVE at every step until the real release
 * response confirms RELEASED).
 */
export type ReleaseFlowState =
  | { stage: "idle" }
  | { stage: "requesting" }
  | { stage: "pending"; holdId: string; requestRef: string; requestedBy: string }
  | { stage: "deciding"; holdId: string; requestRef: string; requestedBy: string }
  | { stage: "releasing"; holdId: string; requestRef: string }
  | { stage: "error"; message: string };

// PBAC actions (deny-by-omission via PolicyGated — absent, never disabled-with-
// excuse, except the hold⇒dispose gate which is a deliberate fail-closed lock).
export const EVIDENCE_ACTIONS = {
  read: "evidence.read",
  custodyManage: "evidence.custody.manage",
  holdManage: "evidence.hold.manage",
  dispose: "evidence.dispose",
} as const;
