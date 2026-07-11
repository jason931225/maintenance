#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! RUNTIME proofs for approvals-CREATE, exercised as the genuine non-owner
//! `mnt_rt` role (NOSUPERUSER, NOBYPASSRLS, FORCE RLS) — the only faithful
//! exercise of RLS org-isolation.
//!
//! Proves:
//!   (a) create a pending request (requester recorded), then a DISTINCT approver
//!       decides it → approved; the decision's requester is the one the request
//!       recorded (authoritative), not whatever the decide caller supplies;
//!   (b) self-decide (approver == the request's recorded requester) is rejected,
//!       even when the decide command lies about `requested_by`, and writes no
//!       decision row;
//!   (c) the pending request row is append-only (UPDATE/DELETE rejected);
//!   (d) a cross-org request is invisible under another tenant's GUC (RLS).

use mnt_governance_adapter_postgres::PgGovernanceStore;
use mnt_governance_application::{ApprovalDecision, CreateApprovalCommand, DecideApprovalCommand};
use mnt_kernel_core::{OrgId, TraceContext, UserId};
use mnt_platform_request_context::scope_org;
use serde_json::json;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

const ORG_A: Uuid = Uuid::from_u128(0x1111_1111_1111_1111_1111_1111_1111_1111);
const ORG_B: Uuid = Uuid::from_u128(0x2222_2222_2222_2222_2222_2222_2222_2222);

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

async fn seed_org(pool: &PgPool, org: Uuid, tag: &str) {
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING")
        .bind(org)
        .bind(format!("org-{tag}"))
        .bind(format!("Org {tag}"))
        .execute(pool)
        .await
        .unwrap();
}

async fn seed_user(pool: &PgPool, org: Uuid, name: &str) -> UserId {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(id)
        .bind(name)
        .bind(["SUPER_ADMIN"].as_slice())
        .bind(org)
        .execute(pool)
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

// (a) create pending → distinct approver decides → approved; requester is the
// one the request recorded, even though decide is told a different requester.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn create_then_decide_by_distinct_approver(pool: PgPool) {
    seed_org(&pool, ORG_A, "alpha").await;
    let requester = seed_user(&pool, ORG_A, "Requester").await;
    let approver = seed_user(&pool, ORG_A, "Approver").await;
    let store = PgGovernanceStore::new(runtime_role_pool(&pool).await);
    let request_ref = Uuid::new_v4();
    let bound_target = Uuid::new_v4();

    let request = scope_org(OrgId::from_uuid(ORG_A), async {
        store
            .create_approval(CreateApprovalCommand {
                requester,
                request_ref,
                kind: "console_view.team_deploy".to_owned(),
                target_ref: Some(bound_target),
                payload_summary: json!({"screen_key": "ops.dashboard", "scope": "team"}),
                trace: trace(),
                occurred_at: now(),
            })
            .await
    })
    .await
    .unwrap();
    assert_eq!(request.requested_by, requester);
    assert_eq!(request.request_ref, request_ref);

    // Decide by the distinct approver. Note the command LIES about requested_by
    // (claims the approver) AND supplies no target — the store must ignore the
    // spoofed requester and source BOTH the requester and the binding target from
    // the pending request row.
    let decision = scope_org(OrgId::from_uuid(ORG_A), async {
        store
            .decide_approval(DecideApprovalCommand {
                approver,
                request_ref,
                kind: "console_view.team_deploy".to_owned(),
                requested_by: approver, // spoofed; must be ignored
                target_ref: None,       // sourced authoritatively from the request
                decision: ApprovalDecision::Approved,
                trace: trace(),
                occurred_at: now(),
            })
            .await
    })
    .await
    .unwrap();
    assert_eq!(decision.decision, ApprovalDecision::Approved);
    assert_eq!(
        decision.requested_by, requester,
        "authoritative requester comes from the pending request, not the client"
    );
    assert_eq!(decision.approver_id, approver);
    let recorded_target: Option<Uuid> =
        sqlx::query_scalar("SELECT target_ref FROM gov_approvals WHERE request_ref = $1")
            .bind(request_ref)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        recorded_target,
        Some(bound_target),
        "the binding target is sourced from the pending request, not the decide body"
    );
}

// (b) self-decide is rejected: the approver IS the request's recorded requester,
// even though the decide command claims someone else asked. Zero decision rows.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn self_decide_is_rejected_against_recorded_requester(pool: PgPool) {
    seed_org(&pool, ORG_A, "alpha").await;
    let requester = seed_user(&pool, ORG_A, "Requester").await;
    let other = seed_user(&pool, ORG_A, "Other").await;
    let store = PgGovernanceStore::new(runtime_role_pool(&pool).await);
    let request_ref = Uuid::new_v4();

    scope_org(OrgId::from_uuid(ORG_A), async {
        store
            .create_approval(CreateApprovalCommand {
                requester,
                request_ref,
                kind: "override".to_owned(),
                target_ref: None,
                payload_summary: json!({}),
                trace: trace(),
                occurred_at: now(),
            })
            .await
    })
    .await
    .unwrap();

    let result = scope_org(OrgId::from_uuid(ORG_A), async {
        store
            .decide_approval(DecideApprovalCommand {
                approver: requester, // == the recorded requester
                request_ref,
                kind: "override".to_owned(),
                requested_by: other, // lie: claim someone else asked
                target_ref: None,
                decision: ApprovalDecision::Approved,
                trace: trace(),
                occurred_at: now(),
            })
            .await
    })
    .await;
    assert!(result.is_err(), "self-decide must be rejected");

    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM gov_approvals WHERE request_ref = $1")
            .bind(request_ref)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 0, "a rejected self-decide writes no decision row");
}

// (c) the pending request row is append-only.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn pending_request_is_append_only(pool: PgPool) {
    seed_org(&pool, ORG_A, "alpha").await;
    let requester = seed_user(&pool, ORG_A, "Requester").await;
    let store = PgGovernanceStore::new(runtime_role_pool(&pool).await);

    let request = scope_org(OrgId::from_uuid(ORG_A), async {
        store
            .create_approval(CreateApprovalCommand {
                requester,
                request_ref: Uuid::new_v4(),
                kind: "override".to_owned(),
                target_ref: None,
                payload_summary: json!({"note": "x"}),
                trace: trace(),
                occurred_at: now(),
            })
            .await
    })
    .await
    .unwrap();

    let update = sqlx::query("UPDATE gov_approval_requests SET kind = 'y' WHERE id = $1")
        .bind(request.id)
        .execute(&pool)
        .await;
    assert!(
        update.is_err(),
        "gov_approval_requests UPDATE must be rejected"
    );
    let delete = sqlx::query("DELETE FROM gov_approval_requests WHERE id = $1")
        .bind(request.id)
        .execute(&pool)
        .await;
    assert!(
        delete.is_err(),
        "gov_approval_requests DELETE must be rejected"
    );
}

// (d) cross-org pending requests are invisible under another tenant's GUC.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn cross_org_requests_are_invisible(pool: PgPool) {
    seed_org(&pool, ORG_A, "alpha").await;
    seed_org(&pool, ORG_B, "bravo").await;
    let requester_a = seed_user(&pool, ORG_A, "A").await;
    let store = PgGovernanceStore::new(runtime_role_pool(&pool).await);
    let request_ref = Uuid::new_v4();

    scope_org(OrgId::from_uuid(ORG_A), async {
        store
            .create_approval(CreateApprovalCommand {
                requester: requester_a,
                request_ref,
                kind: "override".to_owned(),
                target_ref: None,
                payload_summary: json!({}),
                trace: trace(),
                occurred_at: now(),
            })
            .await
    })
    .await
    .unwrap();

    // Under org-B's GUC, org-A's request does not exist → a decide finds no
    // pending request and falls back to org-B's client-supplied requester. Both
    // decide parties are org-B users (the gov_approvals FK is (id, org_id)). Had
    // org-A's request been visible, the store would have overridden requested_by
    // with the org-A requester and the org-B FK insert would fail — a successful
    // decide recording requester_b is the invisibility proof.
    let requester_b = seed_user(&pool, ORG_B, "B-req").await;
    let approver_b = seed_user(&pool, ORG_B, "B-app").await;
    let _ = requester_a;
    let decision = scope_org(OrgId::from_uuid(ORG_B), async {
        store
            .decide_approval(DecideApprovalCommand {
                approver: approver_b,
                request_ref,
                kind: "override".to_owned(),
                requested_by: requester_b,
                target_ref: None,
                decision: ApprovalDecision::Approved,
                trace: trace(),
                occurred_at: now(),
            })
            .await
    })
    .await
    .unwrap();
    assert_eq!(decision.requested_by, requester_b);
}
