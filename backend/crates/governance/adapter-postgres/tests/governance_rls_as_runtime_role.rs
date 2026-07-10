#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! RUNTIME governance gates, exercised as the genuine non-owner role `mnt_rt`.
//!
//! Why `mnt_rt` and not the default `#[sqlx::test]` pool: that pool connects as a
//! BYPASSRLS superuser and would see every tenant's rows regardless of
//! `app.current_org`, green-lighting a totally broken isolation policy. We SEED
//! as the owner and RUN every governance mutation/read as `mnt_rt` (NOSUPERUSER,
//! NOBYPASSRLS, FORCE RLS) — the only faithful exercise of the tenant policy.
//!
//! Proves:
//!   (a) self-approval is rejected — in the store AND by the DB CHECK;
//!   (b) a four-eyes decision by a distinct principal is appended and is
//!       thereafter immutable (append-only: UPDATE/DELETE rejected);
//!   (c) cross-org override rows are invisible under RLS as `mnt_rt`;
//!   (d) the §16 gate chain fail-closes: with a required four-eyes gate and NO
//!       approval, the chain denies and nothing is written.

use mnt_governance_adapter_postgres::PgGovernanceStore;
use mnt_governance_application::{
    ApprovalDecision, ConfigureTransitionCommand, DecideApprovalCommand, OpenOverrideCommand,
};
use mnt_governance_domain::{
    AuthorityEffect, GateChainConfig, GateEvidence, LifecycleState, TransitionRequirements,
    evaluate_gate_chain,
};
use mnt_kernel_core::{OrgId, TraceContext, UserId};
use mnt_platform_request_context::scope_org;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

const ORG_A: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_0001);
const ORG_B: Uuid = Uuid::from_u128(0xB000_0000_0000_0000_0000_0000_0000_0002);

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

async fn seed_org(pool: &PgPool, org_id: Uuid, slug: &str) {
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)")
        .bind(org_id)
        .bind(slug)
        .bind(format!("Org {slug}"))
        .execute(pool)
        .await
        .unwrap();
}

async fn seed_user(pool: &PgPool, org_id: Uuid, name: &str) -> UserId {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO users (display_name, roles, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(name)
    .bind(["SUPER_ADMIN"].as_slice())
    .bind(org_id)
    .fetch_one(pool)
    .await
    .unwrap();
    UserId::from_uuid(id)
}

fn trace() -> TraceContext {
    TraceContext::generate()
}

fn now() -> time::OffsetDateTime {
    time::OffsetDateTime::now_utc()
}

// (a) Self-approval rejected in the store, and by the DB CHECK.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn self_approval_is_rejected(pool: PgPool) {
    seed_org(&pool, ORG_A, "org-alpha").await;
    let requester = seed_user(&pool, ORG_A, "Requester").await;
    let rt = runtime_role_pool(&pool).await;
    let store = PgGovernanceStore::new(rt.clone());
    let request_ref = Uuid::new_v4();

    // Store rejects approver == requester before any write.
    let result = scope_org(OrgId::from_uuid(ORG_A), async {
        store
            .decide_approval(DecideApprovalCommand {
                approver: requester,
                request_ref,
                kind: "override".to_owned(),
                requested_by: requester,
                decision: ApprovalDecision::Approved,
                trace: trace(),
                occurred_at: now(),
            })
            .await
    })
    .await;
    assert!(
        result.is_err(),
        "self-approval must be rejected by the store"
    );

    // Nothing was written.
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM gov_approvals WHERE request_ref = $1")
            .bind(request_ref)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 0, "rejected self-approval must write no row");

    // The DB CHECK is the backstop: a direct insert with equal ids fails.
    let mut tx = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(ORG_A.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let direct = sqlx::query(
        r#"INSERT INTO gov_approvals
             (id, org_id, request_ref, kind, requested_by, approver_id, decision)
           VALUES ($1, $2, $3, 'override', $4, $4, 'approved')"#,
    )
    .bind(Uuid::new_v4())
    .bind(ORG_A)
    .bind(Uuid::new_v4())
    .bind(requester.as_uuid())
    .execute(tx.as_mut())
    .await;
    assert!(
        direct.is_err(),
        "DB CHECK (approver_id <> requested_by) must reject self-approval"
    );
}

// (b) Distinct-approver decision is appended and thereafter immutable.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn distinct_approval_is_appended_and_immutable(pool: PgPool) {
    seed_org(&pool, ORG_A, "org-alpha").await;
    let requester = seed_user(&pool, ORG_A, "Requester").await;
    let approver = seed_user(&pool, ORG_A, "Approver").await;
    let store = PgGovernanceStore::new(runtime_role_pool(&pool).await);
    let request_ref = Uuid::new_v4();

    let summary = scope_org(OrgId::from_uuid(ORG_A), async {
        store
            .decide_approval(DecideApprovalCommand {
                approver,
                request_ref,
                kind: "override".to_owned(),
                requested_by: requester,
                decision: ApprovalDecision::Approved,
                trace: trace(),
                occurred_at: now(),
            })
            .await
    })
    .await
    .unwrap();
    assert_eq!(summary.decision, ApprovalDecision::Approved);

    // Append-only: UPDATE and DELETE are both rejected by the trigger.
    let update = sqlx::query("UPDATE gov_approvals SET decision = 'rejected' WHERE id = $1")
        .bind(summary.id)
        .execute(&pool)
        .await;
    assert!(update.is_err(), "gov_approvals UPDATE must be rejected");
    let delete = sqlx::query("DELETE FROM gov_approvals WHERE id = $1")
        .bind(summary.id)
        .execute(&pool)
        .await;
    assert!(delete.is_err(), "gov_approvals DELETE must be rejected");
}

// (c) Cross-org override rows are invisible under RLS as mnt_rt.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn cross_org_overrides_are_invisible(pool: PgPool) {
    seed_org(&pool, ORG_A, "org-alpha").await;
    seed_org(&pool, ORG_B, "org-bravo").await;
    let actor_a = seed_user(&pool, ORG_A, "A").await;
    let actor_b = seed_user(&pool, ORG_B, "B").await;
    let store = PgGovernanceStore::new(runtime_role_pool(&pool).await);
    let rt = store.pool().clone();

    let override_a = scope_org(OrgId::from_uuid(ORG_A), async {
        store
            .open_override(OpenOverrideCommand {
                actor: actor_a,
                target_type: "ont_instance".to_owned(),
                target_id: Uuid::new_v4(),
                reason: "edit active instance".to_owned(),
                before_snapshot: serde_json::json!({"state": "ACTIVE"}),
                trace: trace(),
                occurred_at: now(),
            })
            .await
    })
    .await
    .unwrap();

    let override_b = scope_org(OrgId::from_uuid(ORG_B), async {
        store
            .open_override(OpenOverrideCommand {
                actor: actor_b,
                target_type: "ont_instance".to_owned(),
                target_id: Uuid::new_v4(),
                reason: "edit active instance".to_owned(),
                before_snapshot: serde_json::json!({"state": "ACTIVE"}),
                trace: trace(),
                occurred_at: now(),
            })
            .await
    })
    .await
    .unwrap();

    // As mnt_rt under org-A's armed GUC, only A's override is visible.
    let mut tx = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(ORG_A.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let visible: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM gov_overrides")
        .fetch_all(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert!(
        visible.contains(&override_a.id),
        "A must see its own override"
    );
    assert!(
        !visible.contains(&override_b.id),
        "A must NOT see org-B's override under RLS"
    );
}

// (d) §16 gate chain fail-closes: required four-eyes gate + no approval ⇒ deny,
//     nothing written; a distinct approval then flips it to allow.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn gate_chain_fails_closed_without_four_eyes(pool: PgPool) {
    seed_org(&pool, ORG_A, "org-alpha").await;
    let admin = seed_user(&pool, ORG_A, "Admin").await;
    let requester = seed_user(&pool, ORG_A, "Requester").await;
    let approver = seed_user(&pool, ORG_A, "Approver").await;
    let store = PgGovernanceStore::new(runtime_role_pool(&pool).await);
    let object_type_id = Uuid::new_v4();
    let request_ref = Uuid::new_v4();

    // Configure archive->dispose to require four-eyes.
    scope_org(OrgId::from_uuid(ORG_A), async {
        store
            .configure_transition(ConfigureTransitionCommand {
                actor: admin,
                object_type_id,
                from_state: LifecycleState::Archived,
                to_state: LifecycleState::Disposed,
                requirements: TransitionRequirements {
                    requires_reason: true,
                    requires_four_eyes: true,
                    requires_checklist: false,
                },
                trace: trace(),
                occurred_at: now(),
            })
            .await
    })
    .await
    .unwrap();

    // No approval yet ⇒ four-eyes evidence is None ⇒ fail-closed deny.
    let denied = assess_dispose_gate(&store, object_type_id, request_ref).await;
    assert!(!denied.allow, "missing four-eyes must deny (fail-closed)");
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM gov_approvals WHERE request_ref = $1")
            .bind(request_ref)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 0, "a denied gate chain must have written nothing");

    // Record a distinct-principal approval, then the chain allows.
    scope_org(OrgId::from_uuid(ORG_A), async {
        store
            .decide_approval(DecideApprovalCommand {
                approver,
                request_ref,
                kind: "lifecycle.dispose".to_owned(),
                requested_by: requester,
                decision: ApprovalDecision::Approved,
                trace: trace(),
                occurred_at: now(),
            })
            .await
    })
    .await
    .unwrap();

    let allowed = assess_dispose_gate(&store, object_type_id, request_ref).await;
    assert!(allowed.allow, "distinct four-eyes approval must allow");
}

/// Build the archive->dispose gate chain from the configured requirements and
/// the four-eyes evidence read from the DB under org-A.
async fn assess_dispose_gate(
    store: &PgGovernanceStore,
    object_type_id: Uuid,
    request_ref: Uuid,
) -> mnt_governance_domain::GateChainOutcome {
    let reqs = scope_org(OrgId::from_uuid(ORG_A), async {
        store
            .transition_requirements(
                object_type_id,
                LifecycleState::Archived,
                LifecycleState::Disposed,
            )
            .await
    })
    .await
    .unwrap()
    .expect("transition is configured");
    let four_eyes = scope_org(OrgId::from_uuid(ORG_A), async {
        store.four_eyes_approved(request_ref).await
    })
    .await
    .unwrap();
    let config = GateChainConfig {
        authority: true,
        self_checklist: reqs.requires_checklist,
        four_eyes: reqs.requires_four_eyes,
        egress_dlp: false,
    };
    let evidence = GateEvidence {
        authority: Some(AuthorityEffect::Allow),
        checklist_all_acknowledged: None,
        four_eyes_approved: four_eyes,
        egress_cleared: None,
    };
    evaluate_gate_chain(config, &evidence)
}
