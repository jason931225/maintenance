#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! L20 audit-chain seal + verify suite, proven as the GENUINE non-owner runtime
//! role `mnt_rt` (NOSUPERUSER, NOBYPASSRLS, FORCE RLS) — NEVER the BYPASSRLS
//! superuser the default `#[sqlx::test]` pool connects as, which would mask a
//! broken RLS policy or grant.
//!
//! The tamper tests simulate the charter's threat actor — a party with direct
//! DB write access who can DISABLE the append-only trigger on `audit_events`
//! (via `session_replication_role = replica`) and bypass RLS (superuser owner
//! connection). The point is not that the trigger holds (it is assumed bypassed)
//! but that the CHAIN detects the tamper the trigger no longer stops.

use std::sync::Arc;

use mnt_kernel_core::{AuditAction, AuditEvent, BranchId, OrgId, TraceContext, UserId};
use mnt_platform_audit_chain::{
    ChainReportKind, InMemoryEd25519Signer, SealConfig, SealSigner, seal_org_once, verify_org_chain,
};
use mnt_platform_db::{DbError, with_audit};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

/// A second, non-KNL tenant id, to prove cross-tenant isolation under `mnt_rt`.
const ORG_B: Uuid = Uuid::from_u128(0x2222_2222_2222_2222_2222_2222_2222_2222);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// A pool whose every connection runs `SET ROLE mnt_rt`, so statements execute
/// as the production runtime role (NOSUPERUSER, NOBYPASSRLS) under FORCE RLS.
async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(4)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET ROLE mnt_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap()
}

fn signer() -> Arc<dyn SealSigner> {
    Arc::new(InMemoryEd25519Signer::generate().unwrap())
}

/// Immediate-seal config: zero lag so freshly written rows are sealable at once
/// (the watermark is exercised separately in `watermark_defers_fresh_rows`).
fn immediate() -> SealConfig {
    SealConfig {
        seal_lag: Duration::ZERO,
        batch_max: 500,
    }
}

async fn seed_org(owner_pool: &PgPool, org: Uuid, tag: &str) {
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
    )
    .bind(org)
    .bind(format!("org-{}-{}", tag.to_lowercase(), Uuid::new_v4().simple()))
    .bind(format!("Org {tag}"))
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

/// Seed a region + branch + user for `org` (owner pool, row_security off).
/// Audit actors FK `users` and branches FK `branches`, so every fixture must be
/// a real row.
async fn seed_tenant(owner_pool: &PgPool, org: Uuid, tag: &str) -> (Uuid, Uuid) {
    seed_org(owner_pool, org, tag).await;
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    let region_id: Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(format!("Region {tag}"))
            .bind(org)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    let branch_id: Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(region_id)
    .bind(format!("Branch {tag}"))
    .bind(org)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let user_id: Uuid = sqlx::query_scalar(
        "INSERT INTO users (display_name, roles, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(format!("User {tag}"))
    .bind(vec!["MECHANIC".to_string()])
    .bind(org)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    (branch_id, user_id)
}

/// Write `n` audit rows for `org` via the real `with_audit` path as `mnt_rt`
/// (arms `app.current_org`, RLS-scoped INSERT). Returns their ids in write order.
async fn write_events(
    rt_pool: &PgPool,
    org: Uuid,
    actor: Uuid,
    branch: Uuid,
    n: usize,
) -> Vec<Uuid> {
    let mut ids = Vec::with_capacity(n);
    for i in 0..n {
        let event = AuditEvent::new(
            Some(UserId::from_uuid(actor)),
            AuditAction::new(format!("test.event_{i}")).unwrap(),
            "audit_chain_test",
            format!("target-{i}"),
            TraceContext::generate(),
            OffsetDateTime::now_utc(),
        )
        .with_org(OrgId::from_uuid(org))
        .with_branch(BranchId::from_uuid(branch))
        .with_snapshots(
            Some(serde_json::json!({"z": "last", "i": i})),
            Some(serde_json::json!({"i": i, "done": true})),
        );
        let id = *event.id.as_uuid();
        with_audit::<_, (), DbError>(rt_pool, event, |_tx| Box::pin(async move { Ok(()) }))
            .await
            .unwrap();
        ids.push(id);
    }
    ids
}

/// Count seals for `org` as the owner (bypassing RLS), for cross-checks.
async fn owner_seal_count(owner_pool: &PgPool, org: Uuid) -> i64 {
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_chain_seals WHERE org_id = $1")
        .bind(org)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    n
}

/// The `seal_hash` of a given `(org, seq)` seal, as the owner.
async fn owner_seal_hash(owner_pool: &PgPool, org: Uuid, seq: i64) -> Vec<u8> {
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    let hash: Vec<u8> = sqlx::query_scalar(
        "SELECT seal_hash FROM audit_chain_seals WHERE org_id = $1 AND seq = $2",
    )
    .bind(org)
    .bind(seq)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    hash
}

/// Begin an owner transaction with the append-only trigger AND RLS bypassed,
/// simulating the threat actor (DB owner / leaked superuser) editing sealed
/// evidence the append-only trigger normally forbids. `session_replication_role
/// = replica` disables user triggers; the superuser owner already bypasses RLS.
async fn tamper_prelude(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>) {
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(&mut **tx)
        .await
        .unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut **tx)
        .await
        .unwrap();
}

/// Tamper a single-`Uuid`-keyed row (`WHERE id = $1`) as the threat actor.
async fn owner_tamper_uuid(owner_pool: &PgPool, sql: &str, id: Uuid) {
    let mut tx = owner_pool.begin().await.unwrap();
    tamper_prelude(&mut tx).await;
    sqlx::query(sql).bind(id).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
}

/// Tamper an `(org_id, seq)`-keyed seal (`WHERE org_id = $1 AND seq = $2`).
async fn owner_tamper_seal(owner_pool: &PgPool, sql: &str, org: Uuid, seq: i64) {
    let mut tx = owner_pool.begin().await.unwrap();
    tamper_prelude(&mut tx).await;
    sqlx::query(sql)
        .bind(org)
        .bind(seq)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

// ---------------------------------------------------------------------------
// §6.1 seal → verify happy path
// ---------------------------------------------------------------------------
#[sqlx::test(migrations = "../db/migrations")]
async fn seal_then_verify_happy_path(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let signer = signer();
    let org = *OrgId::knl().as_uuid();
    let (branch, user) = seed_tenant(&owner_pool, org, "A").await;

    let ids = write_events(&rt, org, user, branch, 3).await;
    let now = OffsetDateTime::now_utc();
    let cfg = immediate();

    let summary = seal_org_once(&rt, OrgId::from_uuid(org), &signer, now, &cfg)
        .await
        .unwrap()
        .expect("three fresh rows must seal");
    assert_eq!(summary.seq, 1, "genesis seal is seq 1");
    assert_eq!(summary.row_count, 3, "all three rows sealed");
    assert_eq!(summary.prev_seal_hash, [0u8; 32], "genesis links to zero");
    assert_eq!(owner_seal_count(&owner_pool, org).await, 1);

    let report = verify_org_chain(&rt, OrgId::from_uuid(org), &signer, now, &cfg)
        .await
        .unwrap();
    assert!(report.ok, "untampered chain verifies: {report:?}");
    assert_eq!(report.kind, ChainReportKind::Ok);
    let _ = ids;
}

// ---------------------------------------------------------------------------
// §6.2 detect a row edit
// ---------------------------------------------------------------------------
#[sqlx::test(migrations = "../db/migrations")]
async fn verify_detects_sealed_row_edit(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let signer = signer();
    let org = *OrgId::knl().as_uuid();
    let (branch, user) = seed_tenant(&owner_pool, org, "A").await;
    let ids = write_events(&rt, org, user, branch, 3).await;
    let now = OffsetDateTime::now_utc();
    let cfg = immediate();
    seal_org_once(&rt, OrgId::from_uuid(org), &signer, now, &cfg)
        .await
        .unwrap()
        .unwrap();

    // Attacker edits a sealed row's content (trigger + RLS bypassed).
    owner_tamper_uuid(
        &owner_pool,
        "UPDATE audit_events SET action = 'tampered.action' WHERE id = $1",
        ids[1],
    )
    .await;

    let report = verify_org_chain(&rt, OrgId::from_uuid(org), &signer, now, &cfg)
        .await
        .unwrap();
    assert!(!report.ok);
    assert_eq!(report.kind, ChainReportKind::BatchHashMismatch);
    assert_eq!(report.first_bad_seq, Some(1));
}

// ---------------------------------------------------------------------------
// §6.3 detect a row delete
// ---------------------------------------------------------------------------
#[sqlx::test(migrations = "../db/migrations")]
async fn verify_detects_sealed_row_delete(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let signer = signer();
    let org = *OrgId::knl().as_uuid();
    let (branch, user) = seed_tenant(&owner_pool, org, "A").await;
    let ids = write_events(&rt, org, user, branch, 3).await;
    let now = OffsetDateTime::now_utc();
    let cfg = immediate();
    seal_org_once(&rt, OrgId::from_uuid(org), &signer, now, &cfg)
        .await
        .unwrap()
        .unwrap();

    owner_tamper_uuid(
        &owner_pool,
        "DELETE FROM audit_events WHERE id = $1",
        ids[1],
    )
    .await;

    let report = verify_org_chain(&rt, OrgId::from_uuid(org), &signer, now, &cfg)
        .await
        .unwrap();
    assert!(!report.ok);
    assert_eq!(report.kind, ChainReportKind::BatchHashMismatch);
    assert_eq!(report.first_bad_seq, Some(1));
}

// ---------------------------------------------------------------------------
// §6.4a detect a tampered seal scalar → SealHashMismatch
// §6.4b detect a tampered seal_hash → BadSignature
// ---------------------------------------------------------------------------
#[sqlx::test(migrations = "../db/migrations")]
async fn verify_detects_seal_scalar_and_hash_tamper(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let signer = signer();
    let org = *OrgId::knl().as_uuid();
    let (branch, user) = seed_tenant(&owner_pool, org, "A").await;
    write_events(&rt, org, user, branch, 2).await;
    let now = OffsetDateTime::now_utc();
    let cfg = immediate();
    seal_org_once(&rt, OrgId::from_uuid(org), &signer, now, &cfg)
        .await
        .unwrap()
        .unwrap();

    // (a) Bump a stored scalar (row_count) without touching seal_hash/signature:
    //     the seal_hash no longer matches its own fields → SealHashMismatch.
    owner_tamper_seal(
        &owner_pool,
        "UPDATE audit_chain_seals SET row_count = row_count + 1 WHERE org_id = $1 AND seq = $2",
        org,
        1,
    )
    .await;
    let report = verify_org_chain(&rt, OrgId::from_uuid(org), &signer, now, &cfg)
        .await
        .unwrap();
    assert_eq!(report.kind, ChainReportKind::SealHashMismatch, "{report:?}");
    assert_eq!(report.first_bad_seq, Some(1));

    // Restore row_count, then corrupt the seal_hash itself: the stored signature
    // no longer verifies over it → BadSignature.
    owner_tamper_seal(
        &owner_pool,
        "UPDATE audit_chain_seals SET row_count = row_count - 1, \
         seal_hash = decode(repeat('ab', 32), 'hex') WHERE org_id = $1 AND seq = $2",
        org,
        1,
    )
    .await;
    let report = verify_org_chain(&rt, OrgId::from_uuid(org), &signer, now, &cfg)
        .await
        .unwrap();
    assert_eq!(report.kind, ChainReportKind::BadSignature, "{report:?}");
    assert_eq!(report.first_bad_seq, Some(1));
}

// ---------------------------------------------------------------------------
// §6.4c detect a deleted seal → MissingSeq
// ---------------------------------------------------------------------------
#[sqlx::test(migrations = "../db/migrations")]
async fn verify_detects_missing_seq(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let signer = signer();
    let org = *OrgId::knl().as_uuid();
    let (branch, user) = seed_tenant(&owner_pool, org, "A").await;

    write_events(&rt, org, user, branch, 2).await;
    let now1 = OffsetDateTime::now_utc();
    let cfg = immediate();
    seal_org_once(&rt, OrgId::from_uuid(org), &signer, now1, &cfg)
        .await
        .unwrap()
        .unwrap();
    write_events(&rt, org, user, branch, 1).await;
    let now2 = OffsetDateTime::now_utc();
    let s2 = seal_org_once(&rt, OrgId::from_uuid(org), &signer, now2, &cfg)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s2.seq, 2, "second batch is seq 2");

    // Splice out the genesis seal.
    owner_tamper_seal(
        &owner_pool,
        "DELETE FROM audit_chain_seals WHERE org_id = $1 AND seq = $2",
        org,
        1,
    )
    .await;

    let report = verify_org_chain(&rt, OrgId::from_uuid(org), &signer, now2, &cfg)
        .await
        .unwrap();
    assert_eq!(report.kind, ChainReportKind::MissingSeq, "{report:?}");
    assert_eq!(report.first_bad_seq, Some(1));
}

// ---------------------------------------------------------------------------
// §6.5 RLS org-isolation on seals, proven as mnt_rt
// ---------------------------------------------------------------------------
#[sqlx::test(migrations = "../db/migrations")]
async fn seals_isolate_tenants_as_runtime_role(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let signer = signer();
    let org_a = *OrgId::knl().as_uuid();
    let org_b = ORG_B;
    let (branch_a, user_a) = seed_tenant(&owner_pool, org_a, "A").await;
    let (branch_b, user_b) = seed_tenant(&owner_pool, org_b, "B").await;
    let now = OffsetDateTime::now_utc();
    let cfg = immediate();

    write_events(&rt, org_a, user_a, branch_a, 2).await;
    write_events(&rt, org_b, user_b, branch_b, 2).await;
    let now = OffsetDateTime::now_utc().max(now);
    seal_org_once(&rt, OrgId::from_uuid(org_a), &signer, now, &cfg)
        .await
        .unwrap()
        .unwrap();
    seal_org_once(&rt, OrgId::from_uuid(org_b), &signer, now, &cfg)
        .await
        .unwrap()
        .unwrap();

    // Under org A's GUC, mnt_rt sees ONLY A's seal; B's is invisible.
    {
        let mut tx = rt.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(org_a.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        let total: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_chain_seals")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        let b_visible: i64 =
            sqlx::query_scalar("SELECT count(*) FROM audit_chain_seals WHERE org_id = $1")
                .bind(org_b)
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(total, 1, "org A sees exactly its own seal");
        assert_eq!(b_visible, 0, "org B's seal is invisible under A");
    }

    // A cross-org INSERT (org_id = B while GUC = A) is rejected by WITH CHECK.
    {
        let mut tx = rt.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(org_a.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        let err = sqlx::query(
            "INSERT INTO audit_chain_seals \
             (org_id, seq, from_event_id, from_created_at, to_event_id, to_created_at, \
              row_count, batch_hash, prev_seal_hash, seal_hash, signature, key_ref) \
             VALUES ($1, 99, $2, now(), $2, now(), 1, $3, $3, $3, $3, 'k')",
        )
        .bind(org_b)
        .bind(Uuid::new_v4())
        .bind(&[9u8; 32][..])
        .execute(&mut *tx)
        .await
        .expect_err("cross-org seal INSERT must be rejected by RLS WITH CHECK")
        .to_string();
        let _ = tx.rollback().await;
        assert!(
            err.contains("row-level security") || err.contains("violates"),
            "expected an RLS WITH CHECK violation, got: {err}"
        );
    }
}

// ---------------------------------------------------------------------------
// §6.6 seals are immutable to mnt_rt (REVOKE UPDATE + DELETE)
// ---------------------------------------------------------------------------
#[sqlx::test(migrations = "../db/migrations")]
async fn seals_are_immutable_to_runtime_role(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let signer = signer();
    let org = *OrgId::knl().as_uuid();
    let (branch, user) = seed_tenant(&owner_pool, org, "A").await;
    write_events(&rt, org, user, branch, 1).await;
    let now = OffsetDateTime::now_utc();
    seal_org_once(&rt, OrgId::from_uuid(org), &signer, now, &immediate())
        .await
        .unwrap()
        .unwrap();

    let mut tx = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();

    let update_err = sqlx::query("UPDATE audit_chain_seals SET row_count = 999")
        .execute(&mut *tx)
        .await
        .expect_err("mnt_rt must not UPDATE a seal")
        .to_string();
    assert!(
        update_err.contains("permission denied"),
        "UPDATE must be REVOKEd for mnt_rt, got: {update_err}"
    );
    let _ = tx.rollback().await;

    let mut tx = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let delete_err = sqlx::query("DELETE FROM audit_chain_seals")
        .execute(&mut *tx)
        .await
        .expect_err("mnt_rt must not DELETE a seal")
        .to_string();
    assert!(
        delete_err.contains("permission denied"),
        "DELETE must be REVOKEd for mnt_rt, got: {delete_err}"
    );
    let _ = tx.rollback().await;
}

// ---------------------------------------------------------------------------
// §6.7 idempotency + chain linkage
// ---------------------------------------------------------------------------
#[sqlx::test(migrations = "../db/migrations")]
async fn seal_is_idempotent_and_chains(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let signer = signer();
    let org = *OrgId::knl().as_uuid();
    let (branch, user) = seed_tenant(&owner_pool, org, "A").await;
    let cfg = immediate();

    write_events(&rt, org, user, branch, 2).await;
    let first = seal_org_once(
        &rt,
        OrgId::from_uuid(org),
        &signer,
        OffsetDateTime::now_utc(),
        &cfg,
    )
    .await
    .unwrap()
    .expect("first pass seals");
    assert_eq!(first.seq, 1);

    // Second pass with NO new rows: nothing to seal, head unchanged.
    let repeat = seal_org_once(
        &rt,
        OrgId::from_uuid(org),
        &signer,
        OffsetDateTime::now_utc(),
        &cfg,
    )
    .await
    .unwrap();
    assert!(
        repeat.is_none(),
        "idempotent: no second seal without new rows"
    );
    assert_eq!(owner_seal_count(&owner_pool, org).await, 1);

    // Add a row, seal again: seq advances by exactly one and links to seq 1.
    write_events(&rt, org, user, branch, 1).await;
    let second = seal_org_once(
        &rt,
        OrgId::from_uuid(org),
        &signer,
        OffsetDateTime::now_utc(),
        &cfg,
    )
    .await
    .unwrap()
    .expect("new row seals");
    assert_eq!(second.seq, 2, "seq advances by exactly one per batch");

    let seal1_hash = owner_seal_hash(&owner_pool, org, 1).await;
    assert_eq!(
        second.prev_seal_hash.to_vec(),
        seal1_hash,
        "seq 2 must chain to seq 1's seal_hash"
    );
}

// ---------------------------------------------------------------------------
// §6.8 watermark gap-freedom (injected clock, no real sleeps)
// ---------------------------------------------------------------------------
#[sqlx::test(migrations = "../db/migrations")]
async fn watermark_defers_fresh_rows_then_seals_without_gap(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let signer = signer();
    let org = *OrgId::knl().as_uuid();
    let (branch, user) = seed_tenant(&owner_pool, org, "A").await;
    let cfg = SealConfig {
        seal_lag: Duration::seconds(60),
        batch_max: 500,
    };

    write_events(&rt, org, user, branch, 1).await;
    let real_now = OffsetDateTime::now_utc();

    // At the real clock the row is younger than the 60s lag → not yet sealable.
    let too_fresh = seal_org_once(&rt, OrgId::from_uuid(org), &signer, real_now, &cfg)
        .await
        .unwrap();
    assert!(
        too_fresh.is_none(),
        "a row inside the lag window must not seal"
    );

    // Advance the injected clock past the lag → the SAME row seals, no gap.
    let later = real_now + Duration::seconds(120);
    let sealed = seal_org_once(&rt, OrgId::from_uuid(org), &signer, later, &cfg)
        .await
        .unwrap()
        .expect("row older than the watermark must seal");
    assert_eq!(sealed.seq, 1);
    assert_eq!(sealed.row_count, 1);

    let report = verify_org_chain(&rt, OrgId::from_uuid(org), &signer, later, &cfg)
        .await
        .unwrap();
    assert!(report.ok, "no gap after the deferred row seals: {report:?}");
}

// ---------------------------------------------------------------------------
// §6.9 detect broken continuity (mid-chain prev_seal_hash tamper, seq intact)
// ---------------------------------------------------------------------------
#[sqlx::test(migrations = "../db/migrations")]
async fn verify_detects_broken_continuity(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let signer = signer();
    let org = *OrgId::knl().as_uuid();
    let (branch, user) = seed_tenant(&owner_pool, org, "A").await;
    let cfg = immediate();

    // Two seals so seq stays contiguous (1,2) — MissingSeq must NOT mask this.
    write_events(&rt, org, user, branch, 2).await;
    seal_org_once(&rt, OrgId::from_uuid(org), &signer, OffsetDateTime::now_utc(), &cfg)
        .await
        .unwrap()
        .unwrap();
    write_events(&rt, org, user, branch, 1).await;
    let s2 = seal_org_once(&rt, OrgId::from_uuid(org), &signer, OffsetDateTime::now_utc(), &cfg)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(s2.seq, 2);

    // Repoint seq 2's prev_seal_hash to garbage (seq column untouched): the chain
    // link breaks even though both seals still exist.
    owner_tamper_seal(
        &owner_pool,
        "UPDATE audit_chain_seals SET prev_seal_hash = decode(repeat('cd', 32), 'hex') \
         WHERE org_id = $1 AND seq = $2",
        org,
        2,
    )
    .await;

    let report = verify_org_chain(&rt, OrgId::from_uuid(org), &signer, OffsetDateTime::now_utc(), &cfg)
        .await
        .unwrap();
    assert!(!report.ok);
    assert_eq!(report.kind, ChainReportKind::BrokenContinuity, "{report:?}");
    assert_eq!(report.first_bad_seq, Some(2));
}

// ---------------------------------------------------------------------------
// §6.10 an unsealed tail is a FRESHNESS signal, never a tamper failure
// ---------------------------------------------------------------------------
#[sqlx::test(migrations = "../db/migrations")]
async fn unsealed_tail_is_reported_but_ok_stays_true(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let signer = signer();
    let org = *OrgId::knl().as_uuid();
    let (branch, user) = seed_tenant(&owner_pool, org, "A").await;

    // Seal the first batch immediately.
    let now1 = OffsetDateTime::now_utc();
    write_events(&rt, org, user, branch, 2).await;
    seal_org_once(&rt, OrgId::from_uuid(org), &signer, now1, &immediate())
        .await
        .unwrap()
        .unwrap();

    // A new row past the head, left UNSEALED, that is older than the watermark
    // at verify time — the rolling window a healthy live tenant always carries.
    write_events(&rt, org, user, branch, 1).await;
    let cfg = SealConfig {
        seal_lag: Duration::seconds(60),
        batch_max: 500,
    };
    let verify_now = now1 + Duration::seconds(120);
    let report = verify_org_chain(&rt, OrgId::from_uuid(org), &signer, verify_now, &cfg)
        .await
        .unwrap();
    assert!(report.ok, "behind-schedule is not tamper: {report:?}");
    assert_eq!(report.kind, ChainReportKind::Ok);
    assert!(report.unsealed_tail, "the unsealed row is reported as a freshness signal");
}

// ---------------------------------------------------------------------------
// §6.11 detect a row reorder (swap the sort key of two sealed rows)
// ---------------------------------------------------------------------------
#[sqlx::test(migrations = "../db/migrations")]
async fn verify_detects_row_reorder(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let signer = signer();
    let org = *OrgId::knl().as_uuid();
    let (branch, user) = seed_tenant(&owner_pool, org, "A").await;
    let ids = write_events(&rt, org, user, branch, 3).await;
    let now = OffsetDateTime::now_utc();
    let cfg = immediate();
    seal_org_once(&rt, OrgId::from_uuid(org), &signer, now, &cfg)
        .await
        .unwrap()
        .unwrap();

    // Swap the created_at of the first two sealed rows: the (created_at,id) order
    // flips, so the canonical batch bytes change. Detected either as a batch
    // mismatch (still in range) or a coverage gap (pushed out of range) — both
    // prove the reorder does not go unnoticed.
    let mut tx = owner_pool.begin().await.unwrap();
    tamper_prelude(&mut tx).await;
    // Atomic swap of the first and last sealed rows' created_at: UPDATE..FROM
    // reads the pre-statement snapshot, so each row takes the other's old value.
    sqlx::query(
        "UPDATE audit_events AS a SET created_at = b.created_at FROM audit_events AS b \
         WHERE (a.id = $1 AND b.id = $2) OR (a.id = $2 AND b.id = $1)",
    )
    .bind(ids[0])
    .bind(ids[2])
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();

    let report = verify_org_chain(&rt, OrgId::from_uuid(org), &signer, now, &cfg)
        .await
        .unwrap();
    assert!(!report.ok, "a reorder must be detected: {report:?}");
    assert!(
        matches!(
            report.kind,
            ChainReportKind::BatchHashMismatch | ChainReportKind::CoverageGap
        ),
        "reorder → batch mismatch or coverage gap, got {report:?}"
    );
}

// ---------------------------------------------------------------------------
// §6.12 detect a backdated insert into a coverage gap (codex-class hole)
// ---------------------------------------------------------------------------
#[sqlx::test(migrations = "../db/migrations")]
async fn verify_detects_coverage_gap_before_genesis(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let signer = signer();
    let org = *OrgId::knl().as_uuid();
    let (branch, user) = seed_tenant(&owner_pool, org, "A").await;
    let ids = write_events(&rt, org, user, branch, 3).await;
    let now = OffsetDateTime::now_utc();
    let cfg = immediate();
    seal_org_once(&rt, OrgId::from_uuid(org), &signer, now, &cfg)
        .await
        .unwrap()
        .unwrap();

    // Simulate a backdated insert into the pre-genesis gap: move a sealed row's
    // created_at earlier than the genesis seal's `from_`, so a committed row now
    // sits below the first seal's start. verify must PROVE this is uncovered.
    owner_tamper_uuid(
        &owner_pool,
        "UPDATE audit_events SET created_at = created_at - interval '1 hour' WHERE id = $1",
        ids[1],
    )
    .await;

    let report = verify_org_chain(&rt, OrgId::from_uuid(org), &signer, now, &cfg)
        .await
        .unwrap();
    assert!(!report.ok);
    assert_eq!(report.kind, ChainReportKind::CoverageGap, "{report:?}");
    assert_eq!(report.first_bad_seq, Some(1));
}
