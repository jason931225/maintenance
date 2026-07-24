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
use mnt_kernel_core::{EvidenceId, EvidenceObjectId, OrgId, TraceContext, UserId};
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
        as_of: None,
        cursor: None,
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
            "GRANT SELECT ON evidence_media TO mnt_rt",
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
/// Seed the storage service's persisted WORM-replica result.  This fixture
/// models the output of `EvidenceStorageService::replicate_once`, rather than
/// an EV-command claim: the only fields the EV trigger trusts are the row's
/// tenant, verified replica state/time, immutable object key, and checksum.
async fn seed_verified_storage_attestation(
    owner_pool: &PgPool,
    org: Uuid,
    actor: UserId,
    storage_key: &str,
    digest_hex: &str,
) -> EvidenceId {
    let mut tx = owner_pool
        .begin()
        .await
        .expect("begin owner seed transaction");
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .expect("disable RLS for owner fixture");

    let region_id: Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(format!("Evidence region {}", Uuid::new_v4()))
            .bind(org)
            .fetch_one(&mut *tx)
            .await
            .expect("seed region");
    let branch_id: Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(region_id)
    .bind(format!("Evidence branch {}", Uuid::new_v4()))
    .bind(org)
    .fetch_one(&mut *tx)
    .await
    .expect("seed branch");
    let customer_id: Uuid = sqlx::query_scalar(
        "INSERT INTO registry_customers (branch_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(branch_id)
    .bind("Evidence customer")
    .bind(org)
    .fetch_one(&mut *tx)
    .await
    .expect("seed customer");
    let site_id: Uuid = sqlx::query_scalar(
        "INSERT INTO registry_sites (customer_id, branch_id, name, org_id) VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(customer_id)
    .bind(branch_id)
    .bind("Evidence site")
    .bind(org)
    .fetch_one(&mut *tx)
    .await
    .expect("seed site");
    let suffix = (Uuid::new_v4().as_u128() % 10_000) as u16;
    let equipment_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO registry_equipment (
            branch_id, customer_id, site_id, equipment_no, management_no,
            manufacturer_code, kind_code, power_code, status,
            specification, ton_text, model, source_sheet, source_row, org_id
        ) VALUES ($1, $2, $3, $4, $5, 'S', 'T', 'R', '임대', '좌식', '2.5', 'Model', 'test', 1, $6)
        RETURNING id
        "#,
    )
    .bind(branch_id)
    .bind(customer_id)
    .bind(site_id)
    .bind(format!("EVD01-{suffix:04}"))
    .bind(format!("M{suffix:04}"))
    .bind(org)
    .fetch_one(&mut *tx)
    .await
    .expect("seed equipment");
    let work_order_id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO work_orders (
            id, request_no, branch_id, equipment_id, customer_id, site_id,
            requested_by, status, priority, symptom, result_type, org_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'REPORT_SUBMITTED', 'P3', 'Evidence fixture', 'COMPLETED', $8)
        "#,
    )
    .bind(work_order_id)
    .bind(format!("20260724-{:03}", (work_order_id.as_u128() % 1000) as u16))
    .bind(branch_id)
    .bind(equipment_id)
    .bind(customer_id)
    .bind(site_id)
    .bind(*actor.as_uuid())
    .bind(org)
    .execute(&mut *tx)
    .await
    .expect("seed work order");

    let media_id = EvidenceId::new();
    sqlx::query(
        r#"
        INSERT INTO evidence_media (
            id, work_order_id, stage, s3_key, content_type, size_bytes,
            checksum_sha256, uploaded_by, worm_replica_status, verified_at,
            retry_count, next_retry_at, org_id
        ) VALUES ($1, $2, 'REPORT', $3, 'application/pdf', 42,
                  $4, $5, 'VERIFIED', $6, 0, $6, $7)
        "#,
    )
    .bind(*media_id.as_uuid())
    .bind(work_order_id)
    .bind(storage_key)
    .bind(base64_of_hex(digest_hex))
    .bind(*actor.as_uuid())
    .bind(now())
    .bind(org)
    .execute(&mut *tx)
    .await
    .expect("seed verified storage attestation");
    tx.commit()
        .await
        .expect("commit storage attestation fixture");
    media_id
}

async fn register_object(
    store: &PgDocsStore,
    actor: UserId,
    digest_hex: &str,
    storage_key: &str,
    title: &str,
) -> EvidenceObjectId {
    register_object_at(store, actor, digest_hex, storage_key, title, now()).await
}

async fn register_object_at(
    store: &PgDocsStore,
    actor: UserId,
    digest_hex: &str,
    storage_key: &str,
    title: &str,
    occurred_at: OffsetDateTime,
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
                verified_at: Some(occurred_at),
            }),
            tsa_proof: None,
            trace: TraceContext::generate(),
            occurred_at,
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
async fn cursor_scan_is_stable_across_the_immutable_register(owner_pool: PgPool) {
    let rt = rt_pool(&owner_pool).await;
    seed_org_rls_off(&owner_pool, ORG_A, "A").await;
    let actor = seed_admin_user_rls_off(&owner_pool, ORG_A).await;
    let st = state(rt, StubWormStore::default());
    let org = OrgId::from_uuid(ORG_A);

    mnt_platform_request_context::scope_org(org, async {
        register_object(
            st.docs_store(),
            actor,
            &"13".repeat(32),
            "worm/cursor-1",
            "First",
        )
        .await;
        register_object(
            st.docs_store(),
            actor,
            &"14".repeat(32),
            "worm/cursor-2",
            "Second",
        )
        .await;
    })
    .await;

    let first = mnt_platform_request_context::scope_org(org, async {
        st.docs_store()
            .list_objects(ListEvidenceObjectsQuery {
                limit: Some(1),
                ..list_all()
            })
            .await
    })
    .await
    .expect("first cursor page succeeds");
    let cursor = first.next_cursor.clone().expect("first page has cursor");
    assert_eq!(first.total, 2);
    assert_eq!(first.items.len(), 1);

    // The third registration occurs after the first page captured its DB
    // sequence boundary, but its business timestamp is deliberately backdated.
    // It must not enter the already-open scan.
    let backdated_id = mnt_platform_request_context::scope_org(org, async {
        register_object_at(
            st.docs_store(),
            actor,
            &"15".repeat(32),
            "worm/cursor-backdated",
            "Backdated after snapshot",
            now() - time::Duration::days(1),
        )
        .await
    })
    .await;

    let second = mnt_platform_request_context::scope_org(org, async {
        st.docs_store()
            .list_objects(ListEvidenceObjectsQuery {
                limit: Some(1),
                as_of: Some(first.as_of),
                cursor: Some(cursor),
                ..list_all()
            })
            .await
    })
    .await
    .expect("second cursor page succeeds");
    assert_eq!(second.as_of, first.as_of);
    assert_eq!(second.total, 2);
    assert_eq!(second.items.len(), 1);
    assert_ne!(first.items[0].id, second.items[0].id);
    assert_ne!(second.items[0].id, backdated_id);

    let fresh = mnt_platform_request_context::scope_org(org, async {
        st.docs_store().list_objects(list_all()).await
    })
    .await
    .expect("fresh scan succeeds");
    assert_eq!(fresh.total, 3);
    assert!(fresh.items.iter().any(|object| object.id == backdated_id));
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
async fn storage_attestation_controls_original_verification_and_derivative_meaning(
    owner_pool: PgPool,
) {
    let rt = rt_pool(&owner_pool).await;
    seed_org_rls_off(&owner_pool, ORG_A, "A").await;
    let actor = seed_admin_user_rls_off(&owner_pool, ORG_A).await;
    let st = state(rt, StubWormStore::default());
    let org = OrgId::from_uuid(ORG_A);

    // RED regression: command-provided VERIFIED + verified_at without an
    // authoritative storage attestation cannot create a verified original.
    let unproven_id = mnt_platform_request_context::scope_org(org, async {
        register_object(
            st.docs_store(),
            actor,
            &"ab".repeat(32),
            "worm/unproven-original",
            "Caller asserted original",
        )
        .await
    })
    .await;
    let unproven = mnt_platform_request_context::scope_org(org, async {
        st.docs_store()
            .get_object(unproven_id)
            .await
            .expect("unproven detail query succeeds")
            .expect("unproven original exists")
            .copies
            .into_iter()
            .next()
            .expect("unproven original copy exists")
    })
    .await;
    assert_eq!(unproven.worm_status, WormStorageStatus::Pending);
    assert_eq!(unproven.verified_at, None);
    assert_eq!(
        unproven.evidentiary_status,
        EvidenceCopyEvidentiaryStatus::OriginalUnverified
    );

    // Existing storage-service proof path: replicate_once writes a VERIFIED
    // evidence_media row. The EV trigger promotes only when its key + SHA-256
    // match; the requested command status remains PENDING.
    let original_digest = "bc".repeat(32);
    let original_media = seed_verified_storage_attestation(
        &owner_pool,
        ORG_A,
        actor,
        "worm/attested-original",
        &original_digest,
    )
    .await;
    let attested_id = mnt_platform_request_context::scope_org(org, async {
        st.docs_store()
            .create_object(CreateEvidenceObjectCommand {
                actor,
                title: "Attested original".to_owned(),
                description: None,
                source: EvidenceSourceRef::new(
                    EvidenceSourceType::WorkOrderEvidenceMedia,
                    original_media.to_string(),
                    None,
                )
                .expect("valid source"),
                classification: EvidenceClassification::Internal,
                record_owner_user_id: None,
                initial_custody_reason: "registered from storage attestation".to_owned(),
                original: Some(RegisterEvidenceCopyInput {
                    copy_kind: EvidenceCopyKind::Original,
                    derivative_kind: None,
                    parent_copy_id: None,
                    storage: EvidenceStorageRef::new(
                        "seaweedfs-worm",
                        "worm/attested-original",
                        None,
                        None,
                    )
                    .expect("valid storage ref"),
                    source_evidence_media_id: Some(original_media),
                    digest_sha256: Sha256Digest::new(&original_digest).expect("valid digest"),
                    content_type: "application/pdf".to_owned(),
                    size_bytes: 42,
                    worm_status: WormStorageStatus::Pending,
                    verified_at: None,
                }),
                tsa_proof: None,
                trace: TraceContext::generate(),
                occurred_at: now(),
            })
            .await
            .expect("attested original registration succeeds")
            .object
            .id
    })
    .await;
    let attested_original = mnt_platform_request_context::scope_org(org, async {
        st.docs_store()
            .get_object(attested_id)
            .await
            .expect("attested detail query succeeds")
            .expect("attested original exists")
            .copies
            .into_iter()
            .next()
            .expect("attested original copy exists")
    })
    .await;
    assert_eq!(attested_original.worm_status, WormStorageStatus::Verified);
    assert_eq!(attested_original.verified_at, Some(now()));
    assert_eq!(
        attested_original.evidentiary_status,
        EvidenceCopyEvidentiaryStatus::VerifiedOriginal
    );

    let derivative_digest = "cd".repeat(32);
    let derivative_media = seed_verified_storage_attestation(
        &owner_pool,
        ORG_A,
        actor,
        "worm/attested-redaction",
        &derivative_digest,
    )
    .await;
    let derivative = mnt_platform_request_context::scope_org(org, async {
        st.docs_store()
            .register_copy(RegisterEvidenceCopyCommand {
                actor,
                evidence_object_id: attested_id,
                copy: RegisterEvidenceCopyInput {
                    copy_kind: EvidenceCopyKind::Derivative,
                    derivative_kind: Some(DerivativeKind::Redacted),
                    parent_copy_id: Some(attested_original.id),
                    storage: EvidenceStorageRef::new(
                        "seaweedfs-worm",
                        "worm/attested-redaction",
                        None,
                        None,
                    )
                    .expect("valid derivative storage ref"),
                    source_evidence_media_id: Some(derivative_media),
                    digest_sha256: Sha256Digest::new(&derivative_digest).expect("valid digest"),
                    content_type: "application/pdf".to_owned(),
                    size_bytes: 23,
                    worm_status: WormStorageStatus::Pending,
                    verified_at: None,
                },
                trace: TraceContext::generate(),
                occurred_at: now(),
            })
            .await
            .expect("attested derivative registration succeeds")
    })
    .await;
    assert_eq!(derivative.worm_status, WormStorageStatus::Verified);
    assert_eq!(
        derivative.evidentiary_status,
        EvidenceCopyEvidentiaryStatus::NonEvidentiaryDerivative,
        "a storage-verified derivative must never be presented as the evidentiary original"
    );
}
