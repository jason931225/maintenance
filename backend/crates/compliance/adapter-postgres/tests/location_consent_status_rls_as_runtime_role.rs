#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! RUNTIME RLS gate for the GPS location-consent status + transition flow that
//! the 위치동의 (LocationSettingsPage / LocationConsentPanel) screen drives
//! (issue #19.7 — the consent page reportedly did not load / the feature looked
//! non-functional).
//!
//! The existing `location_store` tests run as the BYPASSRLS owner pool, so they
//! never exercise the consent read/write as the genuine non-owner `mnt_rt`
//! (NOSUPERUSER, NOBYPASSRLS, FORCE RLS) — a missing GRANT or a read that fails
//! to arm `app.current_org` would be invisible to them but 500 in production,
//! which is exactly the "page won't load" symptom. This test exercises the whole
//! flow as `mnt_rt` under org A's armed GUC:
//!   (a) `current_consent` on a user with NO row returns NO_RECORD (the initial
//!       page load must NOT error just because nothing was granted yet),
//!   (b) grant → suspend → resume → withdraw each succeed and the status the
//!       handler returns reflects the new state,
//!   (c) after the round-trip a fresh `current_consent` read still works and
//!       reports WITHDRAWN,
//!   (d) cross-tenant: with org B's GUC armed, org A's consent row is invisible
//!       (the read fails closed to NO_RECORD), never leaked.

use mnt_compliance_adapter_postgres::PgComplianceStore;
use mnt_compliance_application::{ConsentTransitionCommand, ConsentTransitionKind};
use mnt_compliance_domain::LocationConsentState;
use mnt_kernel_core::{BranchId, OrgId, TraceContext, UserId};
use mnt_platform_request_context::scope_org;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::OffsetDateTime;
use time::macros::datetime;
use uuid::Uuid;

/// Second tenant org used for cross-tenant isolation assertions.
const ORG_B: Uuid = Uuid::from_u128(0xc000_0000_0000_0000_0000_0000_0000_0007);

/// Runtime-role pool: every connection becomes the genuine non-owner `mnt_rt`
/// (NOBYPASSRLS, subject to FORCE RLS), exactly like production.
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

async fn seed_org(owner_pool: &PgPool, org: Uuid, tag: &str) {
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING")
        .bind(org)
        .bind(format!("org-{}", tag.to_lowercase()))
        .bind(format!("Org {tag}"))
        .execute(owner_pool)
        .await
        .unwrap();
}

/// Seed an org's region + branch + a MECHANIC user on that branch (owner pool,
/// raw inserts with explicit org_id), returning (user, branch).
async fn seed_user_and_branch(owner_pool: &PgPool, org: Uuid, tag: &str) -> (UserId, BranchId) {
    let region_id: Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(format!("{tag} Region"))
            .bind(org)
            .fetch_one(owner_pool)
            .await
            .unwrap();
    let branch_id: Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(region_id)
    .bind(format!("{tag} Branch"))
    .bind(org)
    .fetch_one(owner_pool)
    .await
    .unwrap();
    let user_id: Uuid = sqlx::query_scalar(
        "INSERT INTO users (display_name, roles, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(format!("{tag} Mechanic"))
    .bind(Vec::from(["MECHANIC"]))
    .bind(org)
    .fetch_one(owner_pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(user_id)
        .bind(branch_id)
        .bind(org)
        .execute(owner_pool)
        .await
        .unwrap();
    (UserId::from_uuid(user_id), BranchId::from_uuid(branch_id))
}

fn command(
    kind: ConsentTransitionKind,
    user_id: UserId,
    branch_id: BranchId,
    occurred_at: OffsetDateTime,
) -> ConsentTransitionCommand {
    ConsentTransitionCommand {
        kind,
        actor: Some(user_id),
        user_id,
        branch_id,
        trace: TraceContext::generate(),
        occurred_at,
    }
}

// ===========================================================================
// (a)(b)(c) status read + full grant/suspend/resume/withdraw flow as mnt_rt.
// ===========================================================================
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn consent_status_and_transitions_succeed_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let org_a = OrgId::knl();
    let org_uuid = *org_a.as_uuid();

    seed_org(&owner_pool, org_uuid, "A").await;
    let (user_id, branch_id) = seed_user_and_branch(&owner_pool, org_uuid, "A").await;

    scope_org(org_a, async {
        let store = PgComplianceStore::new(rt_pool.clone());

        // (a) The initial page load: no consent row yet → NO_RECORD, NOT an error.
        let initial = store
            .current_consent(user_id, branch_id)
            .await
            .expect("current_consent must read (NO_RECORD) as mnt_rt under org-A's GUC");
        assert_eq!(initial.state(), LocationConsentState::NoRecord);

        // (b) grant → suspend → resume → withdraw, each surfacing the new state.
        let granted = store
            .transition_consent(command(
                ConsentTransitionKind::Grant,
                user_id,
                branch_id,
                datetime!(2026-06-23 08:00:00 UTC),
            ))
            .await
            .expect("grant must succeed as mnt_rt");
        assert_eq!(granted.state(), LocationConsentState::Granted);

        let suspended = store
            .transition_consent(command(
                ConsentTransitionKind::Suspend,
                user_id,
                branch_id,
                datetime!(2026-06-23 09:00:00 UTC),
            ))
            .await
            .expect("suspend must succeed as mnt_rt");
        assert_eq!(suspended.state(), LocationConsentState::Suspended);

        let resumed = store
            .transition_consent(command(
                ConsentTransitionKind::Resume,
                user_id,
                branch_id,
                datetime!(2026-06-23 10:00:00 UTC),
            ))
            .await
            .expect("resume must succeed as mnt_rt");
        assert_eq!(resumed.state(), LocationConsentState::Granted);

        let withdrawn = store
            .transition_consent(command(
                ConsentTransitionKind::Withdraw,
                user_id,
                branch_id,
                datetime!(2026-06-23 11:00:00 UTC),
            ))
            .await
            .expect("withdraw must succeed as mnt_rt");
        assert_eq!(withdrawn.state(), LocationConsentState::Withdrawn);

        // (c) A fresh read after the round-trip still works and is WITHDRAWN.
        let after = store
            .current_consent(user_id, branch_id)
            .await
            .expect("current_consent must still read as mnt_rt after the round-trip");
        assert_eq!(after.state(), LocationConsentState::Withdrawn);
    })
    .await;

    // Every transition was audited (grant/suspend/resume/withdraw) under org A.
    let consent_audits: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE target_type = 'location_consent' AND org_id = $1",
    )
    .bind(org_uuid)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(consent_audits, 4, "all four transitions must be audited");
}

// ===========================================================================
// (d) Cross-tenant: org A's consent is invisible under org B's armed GUC.
// ===========================================================================
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn consent_read_is_tenant_isolated_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let org_a = OrgId::knl();
    let org_a_uuid = *org_a.as_uuid();
    let org_b = OrgId::from_uuid(ORG_B);

    seed_org(&owner_pool, org_a_uuid, "A").await;
    seed_org(&owner_pool, ORG_B, "B").await;
    let (user_a, branch_a) = seed_user_and_branch(&owner_pool, org_a_uuid, "A").await;

    // Org A grants consent (as mnt_rt, under org A's GUC).
    scope_org(org_a, async {
        let store = PgComplianceStore::new(rt_pool.clone());
        store
            .transition_consent(command(
                ConsentTransitionKind::Grant,
                user_a,
                branch_a,
                datetime!(2026-06-23 08:00:00 UTC),
            ))
            .await
            .expect("org A grant must succeed as mnt_rt");
    })
    .await;

    // Under org B's GUC, org A's user has no visible consent row — the FORCE RLS
    // policy hides it, so the read fails closed to NO_RECORD rather than leaking
    // org A's GRANTED state across the tenant boundary.
    scope_org(org_b, async {
        let store = PgComplianceStore::new(rt_pool.clone());
        let seen = store
            .current_consent(user_a, branch_a)
            .await
            .expect("read must succeed as mnt_rt under org B's GUC");
        assert_eq!(
            seen.state(),
            LocationConsentState::NoRecord,
            "org A's consent must be invisible to org B (tenant isolation)"
        );
    })
    .await;
}
