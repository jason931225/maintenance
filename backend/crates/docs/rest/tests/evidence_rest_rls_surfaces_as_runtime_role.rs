#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! RUNTIME RLS + integrity gate for the console EvidenceCard REST surface.
//!
//! Every assertion runs as the genuine non-owner runtime role `mnt_rt`
//! (NOSUPERUSER, NOBYPASSRLS, FORCE RLS) — NOT the default `#[sqlx::test]`
//! BYPASSRLS superuser pool, which would see every tenant's rows and green-light
//! a cross-org read. It proves the four contract points the EvidenceCard rests
//! on:
//!   1. list is RLS-scoped — an object registered in org A is invisible under B;
//!   2. detail carries the custody-event chain (the REGISTERED event is present);
//!   3. `verify` performs a REAL fixity check against the WORM store metadata and
//!      DETECTS a tampered hash (store checksum ≠ registered digest ⇒ Mismatch),
//!      while a matching object verifies;
//!   4. an applied legal hold BLOCKS disposal, and RELEASING it is fail-closed
//!      behind a DISTINCT-approver four-eyes decision (no approval ⇒ refused;
//!      a distinct approver's `approved` decision ⇒ release ⇒ disposal unblocked).

use std::collections::HashMap;
use std::sync::Arc;

use mnt_docs_adapter_postgres::PgDocsStore;
use mnt_docs_application::{
    ApplyLegalHoldCommand, CreateEvidenceObjectCommand, DisposeEvidenceObjectCommand,
    ListEvidenceObjectsQuery, RegisterEvidenceCopyCommand, RegisterEvidenceCopyInput,
    ReleaseLegalHoldCommand,
};
use mnt_docs_domain::{
    DerivativeKind, EvidenceClassification, EvidenceCopyEvidentiaryStatus, EvidenceCopyKind,
    EvidenceSourceRef, EvidenceSourceType, EvidenceStorageRef, Sha256Digest, WormStorageStatus,
};
use mnt_docs_rest::{DocsRestState, FixityStatus, HoldError, VerifyOutcome};
use mnt_governance_adapter_postgres::PgGovernanceStore;
use mnt_governance_application::{ApprovalDecision, DecideApprovalCommand};
use mnt_kernel_core::{EvidenceObjectId, OrgId, TraceContext, UserId};
use mnt_platform_storage::{
    CopyObjectRequest, ObjectHead, PresignGetRequest, PresignPutRequest, PresignedUpload,
    RetentionInfo, S3ObjectStore, StorageFuture,
};
use mnt_platform_test_support::{
    grant_mnt_rt, runtime_role_pool, seed_admin_user_rls_off, seed_org_rls_off,
};
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

const WORM_BUCKET: &str = "mnt-worm";
const ORG_A: Uuid = Uuid::from_u128(0xA1A1_A1A1_A1A1_A1A1_A1A1_A1A1_A1A1_A1A1);
const ORG_B: Uuid = Uuid::from_u128(0xB2B2_B2B2_B2B2_B2B2_B2B2_B2B2_B2B2_B2B2);

// ---------------------------------------------------------------------------
// A stub WORM object store: HEAD returns a preconfigured checksum per key, so a
// test can present the store's recorded SHA-256 as matching or mismatching the
// digest persisted at registration. Only `head_object` is exercised.
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
struct StubWormStore {
    /// key -> lowercase-hex SHA-256 the store "recorded" for that object.
    heads: HashMap<String, String>,
}

impl StubWormStore {
    fn with(mut self, key: &str, hex_digest: &str) -> Self {
        self.heads.insert(key.to_owned(), hex_digest.to_owned());
        self
    }
}

fn base64_of_hex(hex_digest: &str) -> String {
    use base64::Engine as _;
    let bytes = hex::decode(hex_digest).expect("valid hex digest");
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

impl S3ObjectStore for StubWormStore {
    fn head_object(&self, _bucket: String, key: String) -> StorageFuture<'_, ObjectHead> {
        let checksum = self.heads.get(&key).map(|hex| base64_of_hex(hex));
        Box::pin(async move {
            Ok(ObjectHead {
                size_bytes: 42,
                e_tag: Some("\"etag\"".to_owned()),
                checksum_sha256: checksum,
                object_lock_mode: Some("COMPLIANCE".to_owned()),
                retain_until: None,
            })
        })
    }

    fn presign_put(&self, _r: PresignPutRequest) -> StorageFuture<'_, PresignedUpload> {
        Box::pin(async { unreachable!("stub: presign_put unused") })
    }
    fn presign_get(&self, _r: PresignGetRequest) -> StorageFuture<'_, String> {
        Box::pin(async { unreachable!("stub: presign_get unused") })
    }
    fn copy_object(&self, _r: CopyObjectRequest) -> StorageFuture<'_, ()> {
        Box::pin(async { unreachable!("stub: copy_object unused") })
    }
    fn get_object_retention(&self, _b: String, _k: String) -> StorageFuture<'_, RetentionInfo> {
        Box::pin(async { unreachable!("stub: get_object_retention unused") })
    }
    fn get_object(&self, _b: String, _k: String) -> StorageFuture<'_, Vec<u8>> {
        Box::pin(async { unreachable!("stub: get_object unused") })
    }
    fn put_object(
        &self,
        _b: String,
        _k: String,
        _c: String,
        _body: Vec<u8>,
    ) -> StorageFuture<'_, ()> {
        Box::pin(async { unreachable!("stub: put_object unused") })
    }
    fn delete_object(&self, _b: String, _k: String) -> StorageFuture<'_, ()> {
        Box::pin(async { unreachable!("stub: delete_object unused") })
    }
}

/// All-objects list query (every filter unset).
fn list_all() -> ListEvidenceObjectsQuery {
    ListEvidenceObjectsQuery {
        q: None,
        source_type: None,
        source_id: None,
        admissibility_status: None,
        legal_hold_state: None,
        custody_stage: None,
        classification: None,
        limit: None,
        offset: None,
    }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/// A `mnt_rt`-role pool (statements run under FORCE RLS), after granting the
/// base-table privileges that default grants don't cover under the
/// `#[sqlx::test]` superuser. The grant loop itself lives in
/// `mnt_platform_test_support::grant_mnt_rt` (an unscanned crate); the static
/// GRANT literals stay here.
async fn rt_pool(owner_pool: &PgPool) -> PgPool {
    grant_mnt_rt(
        owner_pool,
        &[
            "GRANT SELECT, INSERT ON audit_events TO mnt_rt",
            "GRANT SELECT, INSERT ON gov_approvals TO mnt_rt",
            "GRANT SELECT ON users TO mnt_rt",
            "GRANT SELECT ON organizations TO mnt_rt",
        ],
    )
    .await;
    runtime_role_pool(owner_pool).await
}

fn state(pool: PgPool, stub: StubWormStore) -> DocsRestState {
    DocsRestState::new(
        PgDocsStore::new(pool.clone()),
        PgGovernanceStore::new(pool),
        Some(Arc::new(stub)),
        WORM_BUCKET.to_owned(),
        None, // JWT verifier unused: tests drive the state methods directly.
    )
}

fn now() -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(1_760_000_000).unwrap()
}

/// Register an EV object with a WORM-verified original copy whose stored digest
/// is `digest_hex` and whose storage key is `storage_key`. Returns the id.
async fn register_object(
    store: &PgDocsStore,
    actor: UserId,
    digest_hex: &str,
    storage_key: &str,
    title: &str,
) -> EvidenceObjectId {
    let detail = store
        .create_object(CreateEvidenceObjectCommand {
            actor,
            title: title.to_owned(),
            description: None,
            source: EvidenceSourceRef::new(EvidenceSourceType::ExternalDocument, "src-1", None)
                .unwrap(),
            classification: EvidenceClassification::Internal,
            record_owner_user_id: None,
            initial_custody_reason: "registered for test".to_owned(),
            original: Some(RegisterEvidenceCopyInput {
                copy_kind: EvidenceCopyKind::Original,
                derivative_kind: None,
                parent_copy_id: None,
                storage: EvidenceStorageRef::new("seaweedfs-worm", storage_key, None, None)
                    .unwrap(),
                source_evidence_media_id: None,
                digest_sha256: Sha256Digest::new(digest_hex).unwrap(),
                content_type: "application/pdf".to_owned(),
                size_bytes: 42,
                worm_status: WormStorageStatus::Verified,
                verified_at: Some(now()),
            }),
            tsa_proof: None,
            trace: TraceContext::generate(),
            occurred_at: now(),
        })
        .await
        .expect("create_object under armed org as mnt_rt");
    detail.object.id
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn list_is_rls_scoped_and_detail_carries_custody_chain(owner_pool: PgPool) {
    let rt = rt_pool(&owner_pool).await;
    seed_org_rls_off(&owner_pool, ORG_A, "A").await;
    seed_org_rls_off(&owner_pool, ORG_B, "B").await;
    let actor = seed_admin_user_rls_off(&owner_pool, ORG_A).await;
    let st = state(rt, StubWormStore::default());

    let digest = "11".repeat(32);
    let id = mnt_platform_request_context::scope_org(OrgId::from_uuid(ORG_A), async {
        register_object(st.docs_store(), actor, &digest, "worm/a-1", "Contract A").await
    })
    .await;

    // (1) list is visible in the SAME org, invisible under a DIFFERENT org.
    let in_a = mnt_platform_request_context::scope_org(OrgId::from_uuid(ORG_A), async {
        st.docs_store().list_objects(list_all()).await
    })
    .await
    .unwrap();
    assert_eq!(in_a.total, 1, "the object is visible to its own tenant");

    let in_b = mnt_platform_request_context::scope_org(OrgId::from_uuid(ORG_B), async {
        st.docs_store().list_objects(list_all()).await
    })
    .await
    .unwrap();
    assert_eq!(
        in_b.total, 0,
        "FORCE RLS hides the object from another tenant"
    );

    // (2) detail carries the custody-event chain (REGISTERED present).
    let detail = mnt_platform_request_context::scope_org(OrgId::from_uuid(ORG_A), async {
        st.docs_store().get_object(id).await
    })
    .await
    .unwrap()
    .expect("detail for the object exists in its own tenant");
    assert!(
        !detail.custody_history.is_empty(),
        "the custody chain is surfaced in the detail payload"
    );
    assert_eq!(detail.copies.len(), 1, "the original copy is present");
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn verify_detects_a_tampered_hash(owner_pool: PgPool) {
    let rt = rt_pool(&owner_pool).await;
    seed_org_rls_off(&owner_pool, ORG_A, "A").await;
    let actor = seed_admin_user_rls_off(&owner_pool, ORG_A).await;

    let good_digest = "aa".repeat(32);
    let bad_digest = "bb".repeat(32);
    // The store reports the TRUE digest for the good object's key, but a
    // DIFFERENT digest for the tampered object's key.
    let stub = StubWormStore::default()
        .with("worm/good", &good_digest)
        .with("worm/tampered", &"cc".repeat(32));
    let st = state(rt, stub);

    let (good_id, bad_id) =
        mnt_platform_request_context::scope_org(OrgId::from_uuid(ORG_A), async {
            let good =
                register_object(st.docs_store(), actor, &good_digest, "worm/good", "Good").await;
            let bad = register_object(
                st.docs_store(),
                actor,
                &bad_digest,
                "worm/tampered",
                "Tampered",
            )
            .await;
            (good, bad)
        })
        .await;

    let good_report = mnt_platform_request_context::scope_org(OrgId::from_uuid(ORG_A), async {
        st.verify_object_fixity(actor, good_id, TraceContext::generate(), now())
            .await
    })
    .await
    .expect("verify succeeds for the intact object");
    assert_eq!(good_report.outcome, VerifyOutcome::Verified);
    assert_eq!(good_report.copies[0].status, FixityStatus::Match);

    let bad_report = mnt_platform_request_context::scope_org(OrgId::from_uuid(ORG_A), async {
        st.verify_object_fixity(actor, bad_id, TraceContext::generate(), now())
            .await
    })
    .await
    .expect("verify itself succeeds — it REPORTS the mismatch, not errors");
    assert_eq!(
        bad_report.outcome,
        VerifyOutcome::Mismatch,
        "the store's recorded checksum differs from the registered digest ⇒ tamper detected"
    );
    assert_eq!(bad_report.copies[0].status, FixityStatus::Mismatch);
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn hold_blocks_disposal_and_release_requires_a_distinct_approver(owner_pool: PgPool) {
    let rt = rt_pool(&owner_pool).await;
    seed_org_rls_off(&owner_pool, ORG_A, "A").await;
    let requester = seed_admin_user_rls_off(&owner_pool, ORG_A).await;
    let approver = seed_admin_user_rls_off(&owner_pool, ORG_A).await;
    let st = state(rt, StubWormStore::default());
    let org = OrgId::from_uuid(ORG_A);

    let digest = "dd".repeat(32);
    let id = mnt_platform_request_context::scope_org(org, async {
        register_object(st.docs_store(), requester, &digest, "worm/h-1", "Held").await
    })
    .await;

    // Apply a legal hold, then disposal must be BLOCKED.
    let hold = mnt_platform_request_context::scope_org(org, async {
        st.apply_hold(ApplyLegalHoldCommand {
            actor: requester,
            evidence_object_id: id,
            case_ref: "CASE-1".to_owned(),
            basis: "litigation".to_owned(),
            reason: "preserve".to_owned(),
            trace: TraceContext::generate(),
            occurred_at: now(),
        })
        .await
    })
    .await
    .expect("apply_hold succeeds");

    let dispose_blocked = mnt_platform_request_context::scope_org(org, async {
        st.docs_store()
            .dispose_object(DisposeEvidenceObjectCommand {
                actor: requester,
                evidence_object_id: id,
                reason: "cleanup".to_owned(),
                trace: TraceContext::generate(),
                occurred_at: now(),
            })
            .await
    })
    .await;
    assert!(
        dispose_blocked.is_err(),
        "an ACTIVE legal hold must block disposal"
    );

    // Release with NO four-eyes approval is refused (fail-closed).
    let refused = mnt_platform_request_context::scope_org(org, async {
        st.release_hold(
            Uuid::new_v4(),
            ReleaseLegalHoldCommand {
                actor: approver,
                evidence_object_id: id,
                hold_id: hold.id,
                release_reason: "cleared".to_owned(),
                trace: TraceContext::generate(),
                occurred_at: now(),
            },
        )
        .await
    })
    .await;
    assert!(
        matches!(refused, Err(HoldError::FourEyesRequired)),
        "release without a distinct-approver approval is refused"
    );

    // Record a DISTINCT approver's approval, then release succeeds.
    let request_ref = Uuid::new_v4();
    mnt_platform_request_context::scope_org(org, async {
        st.governance_store()
            .decide_approval(DecideApprovalCommand {
                approver,
                request_ref,
                // Must match the release gate's server-derived binding: the console
                // kind `evidence.hold.release` bound to the hold being released.
                kind: "evidence.hold.release".to_owned(),
                requested_by: requester,
                target_ref: Some(*hold.id.as_uuid()),
                decision: ApprovalDecision::Approved,
                trace: TraceContext::generate(),
                occurred_at: now(),
            })
            .await
    })
    .await
    .expect("a distinct approver records an approval");

    mnt_platform_request_context::scope_org(org, async {
        st.release_hold(
            request_ref,
            ReleaseLegalHoldCommand {
                actor: approver,
                evidence_object_id: id,
                hold_id: hold.id,
                release_reason: "cleared".to_owned(),
                trace: TraceContext::generate(),
                occurred_at: now(),
            },
        )
        .await
    })
    .await
    .expect("release succeeds once a distinct approver has approved");

    // With the hold released, disposal is now permitted.
    mnt_platform_request_context::scope_org(org, async {
        st.docs_store()
            .dispose_object(DisposeEvidenceObjectCommand {
                actor: requester,
                evidence_object_id: id,
                reason: "cleanup".to_owned(),
                trace: TraceContext::generate(),
                occurred_at: now(),
            })
            .await
    })
    .await
    .expect("disposal is unblocked after the hold is released");
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn verified_original_and_derivative_are_explicitly_distinct(owner_pool: PgPool) {
    let rt = rt_pool(&owner_pool).await;
    seed_org_rls_off(&owner_pool, ORG_A, "A").await;
    let actor = seed_admin_user_rls_off(&owner_pool, ORG_A).await;
    let st = state(rt, StubWormStore::default());
    let org = OrgId::from_uuid(ORG_A);
    let original_digest = "ab".repeat(32);

    let id = mnt_platform_request_context::scope_org(org, async {
        register_object(
            st.docs_store(),
            actor,
            &original_digest,
            "worm/original",
            "Sealed original",
        )
        .await
    })
    .await;

    let original = mnt_platform_request_context::scope_org(org, async {
        st.docs_store()
            .get_object(id)
            .await
            .expect("original detail query succeeds")
            .expect("original exists")
            .copies
            .into_iter()
            .next()
            .expect("registered original exists")
    })
    .await;
    assert_eq!(
        original.evidentiary_status,
        EvidenceCopyEvidentiaryStatus::VerifiedOriginal,
        "only the WORM-verified original is evidentiary"
    );

    let derivative = mnt_platform_request_context::scope_org(org, async {
        st.docs_store()
            .register_copy(RegisterEvidenceCopyCommand {
                actor,
                evidence_object_id: id,
                copy: RegisterEvidenceCopyInput {
                    copy_kind: EvidenceCopyKind::Derivative,
                    derivative_kind: Some(DerivativeKind::Redacted),
                    parent_copy_id: Some(original.id),
                    storage: EvidenceStorageRef::new("seaweedfs-worm", "worm/redacted", None, None)
                        .unwrap(),
                    source_evidence_media_id: None,
                    digest_sha256: Sha256Digest::new("cd".repeat(32)).unwrap(),
                    content_type: "application/pdf".to_owned(),
                    size_bytes: 23,
                    worm_status: WormStorageStatus::Verified,
                    verified_at: Some(now()),
                },
                trace: TraceContext::generate(),
                occurred_at: now(),
            })
            .await
            .expect("sealed derivative registration succeeds")
    })
    .await;

    assert_eq!(
        derivative.evidentiary_status,
        EvidenceCopyEvidentiaryStatus::NonEvidentiaryDerivative,
        "a sealed derivative must never be presented as the evidentiary original"
    );
}
