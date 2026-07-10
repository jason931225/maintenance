// Pure display/derivation logic for the EV- evidence surface.
import { ko } from "../../i18n/ko";
import type { ObjectCardDescriptor, StatusTone } from "../objectcard";
import type { AuditRecord } from "../audit";
import type {
  AdmissibilityStatus,
  CustodyStage,
  EvidenceCopy,
  EvidenceLegalHold,
  EvidenceObjectDetail,
  FixityStatus,
  TsaStatus,
  WormStatus,
} from "./types";

const T = ko.console.evidence;

export function admissibilityLabel(status: AdmissibilityStatus): string {
  return T.admissibility[status];
}

export function admissibilityTone(status: AdmissibilityStatus): StatusTone {
  switch (status) {
    case "ADMISSIBLE":
      return "ok";
    case "REVIEW_NEEDED":
      return "warn";
    case "BLOCKED":
      return "purple";
    case "INADMISSIBLE":
      return "danger";
  }
}

export function fixityTone(fixity: FixityStatus): StatusTone {
  return fixity === "VERIFIED" ? "ok" : fixity === "PENDING" ? "info" : "danger";
}

export function tsaTone(tsa: TsaStatus): StatusTone {
  return tsa === "VERIFIED" ? "ok" : tsa === "FAILED" ? "danger" : "neutral";
}

export function wormTone(status: WormStatus): StatusTone {
  return status === "VERIFIED" ? "ok" : status === "PENDING" ? "info" : "danger";
}

/** First 12 hex chars — enough to eyeball, full digest stays in the detail. */
export function shortDigest(sha256: string): string {
  return `${sha256.slice(0, 12)}…`;
}

export function holdActive(holds: readonly EvidenceLegalHold[]): boolean {
  return holds.some((hold) => hold.status === "ACTIVE");
}

export function originalOf(copies: readonly EvidenceCopy[]): EvidenceCopy | undefined {
  return copies.find((copy) => copy.kind === "ORIGINAL");
}

export function derivativesOf(copies: readonly EvidenceCopy[]): EvidenceCopy[] {
  return copies.filter((copy) => copy.kind === "DERIVATIVE");
}

// Audit action → custody stage (contract §11 audit actions → §4.5 ledger).
const AUDIT_CUSTODY_STAGE: Record<string, CustodyStage | undefined> = {
  "evidence_object.register": "REGISTERED",
  "evidence_copy.register_original": "HASH_RECORDED",
  "evidence_copy.confirm_upload": "HASH_RECORDED",
  "evidence_copy.worm_verified": "WORM_REPLICATED",
  "evidence_tsa.verify": "TSA_VERIFIED",
  "evidence_custody.transition": "CUSTODY_TRANSFERRED",
  "evidence_legal_hold.apply": "LEGAL_HOLD_APPLIED",
  "evidence_legal_hold.release": "LEGAL_HOLD_RELEASED",
  "evidence_export.create": "EXPORTED",
  "evidence_disposal.request": "DISPOSAL_REQUESTED",
  "evidence_disposal.complete": "DISPOSED",
};

/**
 * Map an audit-stream action to a custody stage; read/access-shaped actions
 * become ACCESSED, anything unknown returns null (timeline shows the raw action).
 */
export function custodyStageOfAudit(action: string): CustodyStage | null {
  const direct = AUDIT_CUSTODY_STAGE[action];
  if (direct) return direct;
  if (/read|view|access|download|list/.test(action.toLowerCase())) return "ACCESSED";
  return null;
}

export function custodyStageLabel(stage: CustodyStage): string {
  return T.custody.stages[stage];
}

/** Format bytes for display, KB/MB with one decimal. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * §4-14 composition: the EV object rendered through the single object-detail
 * surface. Evidence-specific chrome (fixity/TSA/WORM/custody/hold) is layered
 * by EvidenceCard; evidence actions are PBAC-gated there, so no ObjectCard
 * actions here.
 */
export function toObjectCardDescriptor(
  detail: EvidenceObjectDetail,
  holds: readonly EvidenceLegalHold[],
  custody: readonly AuditRecord[],
): ObjectCardDescriptor {
  const original = originalOf(detail.copies);
  const locked = holdActive(holds);
  const lifecycleState = detail.disposed ? "disposed" : locked ? "locked" : "active";
  return {
    id: detail.id,
    code: detail.code,
    title: detail.title,
    objectType: { key: "evidence_object", title: T.title },
    lifecycleState,
    properties: [
      { key: "classification", title: T.fields.classification, type: "choice", value: detail.classification },
      { key: "custodian", title: T.fields.custodian, type: "user", value: detail.custodian },
      { key: "collected_at", title: T.fields.collectedAt, type: "datetime", value: detail.collectedAt },
      {
        key: "sha256",
        title: T.fields.sha256,
        type: "text",
        value: original ? original.digestSha256 : null,
      },
      {
        key: "content_type",
        title: T.fields.contentType,
        type: "text",
        value: original ? original.contentType : null,
      },
    ],
    relations: detail.source
      ? [
          {
            linkId: `src-${detail.id}`,
            linkType: T.fields.source,
            direction: "from",
            cardinality: "one_one",
            code: detail.source.code,
            title: detail.source.title,
          },
        ]
      : [],
    lifecycle: [
      { state: "draft", reached: true, current: false },
      { state: "active", reached: true, current: lifecycleState === "active" },
      { state: "locked", reached: locked || detail.disposed, current: lifecycleState === "locked" },
      { state: "disposed", reached: detail.disposed, current: lifecycleState === "disposed" },
    ],
    history: custody.map((event, index) => ({
      version: custody.length - index,
      at: event.occurred_at,
      actor: event.actor ?? ko.console.audit.values.systemActor,
      hashVerified: detail.fixity === "VERIFIED",
      action: event.action,
    })),
    actions: [],
  };
}
