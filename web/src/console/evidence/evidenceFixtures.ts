// Test-only fixtures — deliberately NOT exported from index.ts (evidenceStubs
// was deleted; production now always fetches real EV objects via evidenceApi).
// Two rows, shaped exactly like evidenceApi's mappers produce from the wire.
// Korean copy comes from `ko.console.evidence.samples` (no hardcoded UI
// strings), so this ships under console/** past the check-ui-strings gate.
// NOT product data.
import { ko } from "../../i18n/ko";
import type { AuditRecord } from "../audit";
import type { EvidenceObjectDetail } from "./types";

const S = ko.console.evidence.samples;

function custodyEvent(
  id: string,
  action: string,
  actor: string | null,
  occurredAt: string,
  targetId: string,
): AuditRecord {
  return {
    id,
    actor,
    action,
    target_type: "evidence_object",
    target_id: targetId,
    branch_id: null,
    before_snap: null,
    after_snap: null,
    trace_id: `trace-${id}`,
    span_id: `span-${id}`,
    occurred_at: occurredAt,
  };
}

/** [heldWithDerivatives, plainNoDerivatives] — matches the old stub fixture shape. */
export function evidenceFixtures(): [EvidenceObjectDetail, EvidenceObjectDetail] {
  return [
    {
      id: "ev-2026-00012",
      code: "EV-2026-00012",
      title: S.video.title,
      classification: "SENSITIVE",
      admissibility: "ADMISSIBLE",
      custodyStage: "LEGAL_HOLD_APPLIED",
      custodian: S.actors.custodian,
      registeredAt: "2026-07-06T09:12:00+09:00",
      fixity: "VERIFIED",
      tsa: "VERIFIED",
      disposed: false,
      source: { code: "WO-2643", title: S.video.source },
      copies: [
        {
          id: "cp-12-orig",
          kind: "ORIGINAL",
          digestSha256:
            "9f2b6c1e4d8a03b57cfe1a2d4b6c8e0f1a3c5e7d9b1f3a5c7e9d0b2f4a6c8e0d",
          contentType: "video/mp4",
          sizeBytes: 48_236_544,
          wormStatus: "VERIFIED",
          sourceEvidenceMediaId: "5f0c9a4e-2b7d-4c1e-9a3f-8d6b5e4c3a21",
        },
        {
          id: "cp-12-d1",
          kind: "DERIVATIVE",
          derivativeKind: "TRANSCODED",
          parentCopyId: "cp-12-orig",
          digestSha256:
            "1a3c5e7d9b1f3a5c7e9d0b2f4a6c8e0d9f2b6c1e4d8a03b57cfe1a2d4b6c8e0f",
          contentType: "video/mp4",
          sizeBytes: 12_582_912,
          wormStatus: "VERIFIED",
        },
        {
          id: "cp-12-d2",
          kind: "DERIVATIVE",
          derivativeKind: "THUMBNAIL",
          parentCopyId: "cp-12-orig",
          digestSha256:
            "4b6c8e0f1a3c5e7d9b1f3a5c7e9d0b2f4a6c8e0d9f2b6c1e4d8a03b57cfe1a2d",
          contentType: "image/webp",
          sizeBytes: 44_112,
          wormStatus: "VERIFIED",
        },
      ],
      holds: [
        {
          id: "hold-12-1",
          caseRef: S.video.caseRef,
          status: "ACTIVE",
          appliedAt: "2026-07-07T10:00:00+09:00",
        },
      ],
      custody: [
        custodyEvent("cu-12-4", "evidence_legal_hold.apply", S.actors.compliance, "2026-07-07T10:00:00+09:00", "EV-2026-00012"),
        custodyEvent("cu-12-3", "evidence_object.read", S.actors.admin, "2026-07-06T17:40:00+09:00", "EV-2026-00012"),
        custodyEvent("cu-12-2", "evidence_copy.worm_verified", null, "2026-07-06T09:20:00+09:00", "EV-2026-00012"),
        custodyEvent("cu-12-1", "evidence_object.register", S.actors.custodian, "2026-07-06T09:12:00+09:00", "EV-2026-00012"),
      ],
    },
    {
      id: "ev-2026-00013",
      code: "EV-2026-00013",
      title: S.statement.title,
      classification: "INTERNAL",
      admissibility: "REVIEW_NEEDED",
      custodyStage: "HASH_RECORDED",
      custodian: S.actors.custodian,
      registeredAt: "2026-07-08T14:03:00+09:00",
      fixity: "VERIFIED",
      tsa: "PENDING",
      disposed: false,
      source: { code: "AP-3121", title: S.statement.source },
      copies: [
        {
          id: "cp-13-orig",
          kind: "ORIGINAL",
          digestSha256:
            "c7e9d0b2f4a6c8e0d9f2b6c1e4d8a03b57cfe1a2d4b6c8e0f1a3c5e7d9b1f3a5",
          contentType: "application/pdf",
          sizeBytes: 1_863_420,
          wormStatus: "PENDING",
        },
      ],
      holds: [],
      custody: [
        custodyEvent("cu-13-2", "evidence_copy.register_original", S.actors.custodian, "2026-07-08T14:05:00+09:00", "EV-2026-00013"),
        custodyEvent("cu-13-1", "evidence_object.register", S.actors.custodian, "2026-07-08T14:03:00+09:00", "EV-2026-00013"),
      ],
    },
  ];
}
