// wire-pending: Phase C → GET /api/v1/evidence-objects + GET /api/v1/evidence-objects/{id}
// (BE-DOCS EV contract, .omc/handoffs/t_15b1a1ec-ev-object-domain-api-contract.md §7.1/§7.3;
// object substrate per .omc/research/be-ontology-engine-arch.md). This factory
// stands in for that feed with the same shapes, so wiring = replacing the
// factory with the fetch — not rewriting the surface. Custody events here use
// the real /api/audit record shape (console/audit AuditFeed) so the timeline is
// already stream-compatible; the filtered query
// GET /api/audit?target_type=evidence_object&target_id={id} is also wire-pending.
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

export function createEvidenceStubs(): EvidenceObjectDetail[] {
  return [
    {
      id: "ev-2026-00012",
      code: "EV-2026-00012",
      title: S.video.title,
      classification: "SENSITIVE",
      admissibility: "ADMISSIBLE",
      custodyStage: "LEGAL_HOLD_APPLIED",
      custodian: S.actors.custodian,
      collectedAt: "2026-07-06T09:12:00+09:00",
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
      collectedAt: "2026-07-08T14:03:00+09:00",
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
    {
      id: "ev-2026-00009",
      code: "EV-2026-00009",
      title: S.photos.title,
      classification: "CONFIDENTIAL",
      admissibility: "INADMISSIBLE",
      custodyStage: "UNDER_REVIEW",
      custodian: S.actors.compliance,
      collectedAt: "2026-06-29T08:44:00+09:00",
      fixity: "MISMATCH",
      tsa: "FAILED",
      disposed: false,
      copies: [
        {
          id: "cp-9-orig",
          kind: "ORIGINAL",
          digestSha256:
            "e4d8a03b57cfe1a2d4b6c8e0f1a3c5e7d9b1f3a5c7e9d0b2f4a6c8e0d9f2b6c1",
          contentType: "image/jpeg",
          sizeBytes: 6_291_456,
          wormStatus: "FAILED",
        },
      ],
      holds: [
        {
          id: "hold-9-1",
          caseRef: S.photos.caseRef,
          status: "RELEASED",
          appliedAt: "2026-06-30T09:00:00+09:00",
          releasedAt: "2026-07-04T18:00:00+09:00",
        },
      ],
      custody: [
        custodyEvent("cu-9-3", "evidence_legal_hold.release", S.actors.compliance, "2026-07-04T18:00:00+09:00", "EV-2026-00009"),
        custodyEvent("cu-9-2", "evidence_custody.transition", S.actors.compliance, "2026-07-01T11:30:00+09:00", "EV-2026-00009"),
        custodyEvent("cu-9-1", "evidence_object.register", S.actors.field, "2026-06-29T08:44:00+09:00", "EV-2026-00009"),
      ],
    },
  ];
}
