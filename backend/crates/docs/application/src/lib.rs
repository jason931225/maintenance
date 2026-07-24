//! Docs/evidence-object application contracts.
//!
//! Command DTOs intentionally omit `org_id`; adapters derive tenant scope from
//! request context and arm Postgres with `with_org_conn` / `with_audits`.

use mnt_docs_domain::{
    AdmissibilityReason, AdmissibilityStatus, CustodyStage, DerivativeKind, EvidenceClassification,
    EvidenceCode, EvidenceCopyKind, EvidenceSourceRef, EvidenceStorageRef, LegalHoldState,
    LegalHoldStatus, Sha256Digest, TsaProofStatus, WormStorageStatus,
};
use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, EvidenceCopyId, EvidenceCustodyEventId, EvidenceExportId,
    EvidenceId, EvidenceLegalHoldId, EvidenceObjectId, EvidenceTsaProofId, KernelError, Timestamp,
    TraceContext, UserId,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceObjectView {
    pub id: EvidenceObjectId,
    pub code: EvidenceCode,
    pub title: String,
    pub description: Option<String>,
    pub source: EvidenceSourceRef,
    pub classification: EvidenceClassification,
    pub record_owner_user_id: Option<UserId>,
    pub current_custody_stage: CustodyStage,
    pub legal_hold_state: LegalHoldState,
    pub admissibility_status: AdmissibilityStatus,
    pub admissibility_reasons: Vec<AdmissibilityReason>,
    pub admissibility_inputs: serde_json::Value,
    pub created_by: UserId,
    pub updated_by: UserId,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: Timestamp,
    #[serde(with = "time::serde::rfc3339::option")]
    pub disposed_at: Option<Timestamp>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceObjectPage {
    pub items: Vec<EvidenceObjectView>,
    pub limit: i64,
    pub offset: i64,
    pub total: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceCopyView {
    pub id: EvidenceCopyId,
    pub evidence_object_id: EvidenceObjectId,
    pub copy_kind: EvidenceCopyKind,
    pub derivative_kind: Option<DerivativeKind>,
    pub parent_copy_id: Option<EvidenceCopyId>,
    pub storage: EvidenceStorageRef,
    pub source_evidence_media_id: Option<EvidenceId>,
    pub digest_sha256: Sha256Digest,
    pub content_type: String,
    pub size_bytes: i64,
    pub worm_status: WormStorageStatus,
    #[serde(with = "time::serde::rfc3339::option")]
    pub verified_at: Option<Timestamp>,
    pub created_by: UserId,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimestampAuthorityProofView {
    pub id: EvidenceTsaProofId,
    pub copy_id: EvidenceCopyId,
    pub status: TsaProofStatus,
    pub provider: String,
    pub policy_oid: Option<String>,
    pub serial_number: Option<String>,
    pub hash_algorithm: String,
    pub message_imprint_sha256: Option<Sha256Digest>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub generated_at: Option<Timestamp>,
    pub accuracy_millis: Option<i64>,
    pub ordering: Option<bool>,
    pub tsa_cert_fingerprint_sha256: Option<Sha256Digest>,
    pub token_digest_sha256: Option<Sha256Digest>,
    pub token_storage: Option<EvidenceStorageRef>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub verified_at: Option<Timestamp>,
    pub failure_reason: Option<String>,
    pub created_by: UserId,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustodyEventView {
    pub id: EvidenceCustodyEventId,
    pub evidence_object_id: EvidenceObjectId,
    pub stage: CustodyStage,
    pub actor_user_id: UserId,
    pub from_custodian: Option<serde_json::Value>,
    pub to_custodian: Option<serde_json::Value>,
    pub location_label: Option<String>,
    pub reason: String,
    pub source_ref: Option<EvidenceSourceRef>,
    pub audit_event_id: Option<mnt_kernel_core::AuditEventId>,
    pub previous_event_id: Option<EvidenceCustodyEventId>,
    pub event_digest_sha256: Sha256Digest,
    #[serde(with = "time::serde::rfc3339")]
    pub occurred_at: Timestamp,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegalHoldRecordView {
    pub id: EvidenceLegalHoldId,
    pub evidence_object_id: EvidenceObjectId,
    pub status: LegalHoldStatus,
    pub case_ref: String,
    pub basis: String,
    pub reason: String,
    pub applied_by: UserId,
    #[serde(with = "time::serde::rfc3339")]
    pub applied_at: Timestamp,
    pub released_by: Option<UserId>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub released_at: Option<Timestamp>,
    pub release_reason: Option<String>,
    pub audit_event_id: Option<mnt_kernel_core::AuditEventId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceExportView {
    pub id: EvidenceExportId,
    pub evidence_object_id: EvidenceObjectId,
    pub manifest_digest_sha256: Sha256Digest,
    pub signature_algorithm: String,
    pub signature_ref: Option<String>,
    pub export_reason: String,
    pub exported_by: UserId,
    #[serde(with = "time::serde::rfc3339")]
    pub exported_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceObjectDetail {
    pub object: EvidenceObjectView,
    pub copies: Vec<EvidenceCopyView>,
    pub tsa_proofs: Vec<TimestampAuthorityProofView>,
    pub custody_history: Vec<CustodyEventView>,
    pub legal_holds: Vec<LegalHoldRecordView>,
    pub exports: Vec<EvidenceExportView>,
}

/// Typed cross-domain query owned by Docs/Evidence. Equipment passes the
/// authenticated rental-case and branch identity; this port never accepts an
/// untyped URI or storage reference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct EligibleEquipmentHandoverEvidenceQuery {
    pub equipment_case_id: uuid::Uuid,
    pub branch_id: BranchId,
    pub evidence_object_id: EvidenceObjectId,
}

/// An original, verified WORM copy that Docs has admitted for one Equipment
/// handover. The adapter obtains this only after tenant, branch, lifecycle,
/// and custody checks have passed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EligibleEquipmentHandoverEvidence {
    pub equipment_case_id: uuid::Uuid,
    pub branch_id: BranchId,
    pub evidence_object_id: EvidenceObjectId,
    pub original_copy_id: EvidenceCopyId,
    pub digest_sha256: Sha256Digest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListEvidenceObjectsQuery {
    pub q: Option<String>,
    pub source_type: Option<mnt_docs_domain::EvidenceSourceType>,
    pub source_id: Option<String>,
    pub admissibility_status: Option<AdmissibilityStatus>,
    pub legal_hold_state: Option<LegalHoldState>,
    pub custody_stage: Option<CustodyStage>,
    pub classification: Option<EvidenceClassification>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateEvidenceObjectCommand {
    pub actor: UserId,
    pub title: String,
    pub description: Option<String>,
    pub source: EvidenceSourceRef,
    pub classification: EvidenceClassification,
    pub record_owner_user_id: Option<UserId>,
    pub initial_custody_reason: String,
    pub original: Option<RegisterEvidenceCopyInput>,
    pub tsa_proof: Option<TimestampAuthorityProofInput>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegisterEvidenceCopyCommand {
    pub actor: UserId,
    pub evidence_object_id: EvidenceObjectId,
    pub copy: RegisterEvidenceCopyInput,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegisterEvidenceCopyInput {
    pub copy_kind: EvidenceCopyKind,
    pub derivative_kind: Option<DerivativeKind>,
    pub parent_copy_id: Option<EvidenceCopyId>,
    pub storage: EvidenceStorageRef,
    pub source_evidence_media_id: Option<EvidenceId>,
    pub digest_sha256: Sha256Digest,
    pub content_type: String,
    pub size_bytes: i64,
    pub worm_status: WormStorageStatus,
    #[serde(with = "time::serde::rfc3339::option")]
    pub verified_at: Option<Timestamp>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordTsaProofCommand {
    pub actor: UserId,
    pub evidence_object_id: EvidenceObjectId,
    pub copy_id: EvidenceCopyId,
    pub proof: TimestampAuthorityProofInput,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimestampAuthorityProofInput {
    pub status: TsaProofStatus,
    pub provider: String,
    pub policy_oid: Option<String>,
    pub serial_number: Option<String>,
    pub hash_algorithm: String,
    pub message_imprint_sha256: Option<Sha256Digest>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub generated_at: Option<Timestamp>,
    pub accuracy_millis: Option<i64>,
    pub ordering: Option<bool>,
    pub tsa_cert_fingerprint_sha256: Option<Sha256Digest>,
    pub token_digest_sha256: Option<Sha256Digest>,
    pub token_storage: Option<EvidenceStorageRef>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub verified_at: Option<Timestamp>,
    pub failure_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppendCustodyEventCommand {
    pub actor: UserId,
    pub evidence_object_id: EvidenceObjectId,
    pub stage: CustodyStage,
    pub from_custodian: Option<serde_json::Value>,
    pub to_custodian: Option<serde_json::Value>,
    pub location_label: Option<String>,
    pub reason: String,
    pub source_ref: Option<EvidenceSourceRef>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplyLegalHoldCommand {
    pub actor: UserId,
    pub evidence_object_id: EvidenceObjectId,
    pub case_ref: String,
    pub basis: String,
    pub reason: String,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseLegalHoldCommand {
    pub actor: UserId,
    pub evidence_object_id: EvidenceObjectId,
    pub hold_id: EvidenceLegalHoldId,
    pub release_reason: String,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DisposeEvidenceObjectCommand {
    pub actor: UserId,
    pub evidence_object_id: EvidenceObjectId,
    pub reason: String,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecomputeAdmissibilityCommand {
    pub actor: UserId,
    pub evidence_object_id: EvidenceObjectId,
    pub reason: Option<String>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

pub fn evidence_audit_event(
    action: &str,
    actor: Option<UserId>,
    target_type: &str,
    target_id: impl ToString,
    trace: TraceContext,
    occurred_at: Timestamp,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        actor,
        AuditAction::new(action)?,
        target_type,
        target_id.to_string(),
        trace,
        occurred_at,
    ))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn evidence_audit_event_uses_valid_action_and_target() {
        let object_id = EvidenceObjectId::new();
        let event = evidence_audit_event(
            "evidence_object.register",
            Some(UserId::new()),
            "evidence_object",
            object_id,
            TraceContext::generate(),
            time::OffsetDateTime::now_utc(),
        )
        .unwrap();

        assert_eq!(event.action.as_str(), "evidence_object.register");
        assert_eq!(event.target_type, "evidence_object");
        assert_eq!(event.target_id, object_id.to_string());
    }
}
