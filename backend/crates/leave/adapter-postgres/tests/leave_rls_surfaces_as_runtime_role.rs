#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! RUNTIME RLS + branch-isolation + SoD + ledger write-back gate for the
//! leave-request domain.
//!
//! Proven as the genuine non-owner runtime role `mnt_rt` (NOSUPERUSER,
//! NOBYPASSRLS, FORCE RLS) — NOT the `#[sqlx::test]` BYPASSRLS superuser pool,
//! which sees every row and would green-light a broken branch/SoD filter.
//!
//! What this proves:
//!  * an APPROVE moves the subject employee's leave ledger in the same tx;
//!  * a requester cannot decide their OWN request (SoD → Forbidden);
//!  * an approver scoped to another branch cannot see/decide the request
//!    (branch isolation → NotFound, deny-by-omission);
//!  * an empty branch scope yields an empty queue (deny-by-omission);
//!  * another tenant sees none of the requests (RLS);
//!  * a re-decide of a decided request is a Conflict;
//!  * a §61 push delivers a locked legal notice into the target's 개인 수신함
//!    and records the push, idempotently per (target, kind, round).

use std::collections::BTreeSet;
use std::sync::Arc;

use mnt_inbox_adapter_postgres::PgInboxStore;
use mnt_kernel_core::{BranchId, BranchScope, ErrorKind, OrgId, TraceContext, UserId};
use mnt_leave_adapter_postgres::PgLeaveStore;
use mnt_leave_application::{
    CreateLeaveRequestCommand, DecideLeaveRequestCommand, ListLeaveRequestsQuery,
    StatutoryPushCommand,
};
use mnt_leave_domain::{LeaveDecision, LeaveStatus, LeaveType, PromotionKind};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::{Month, OffsetDateTime};
use uuid::Uuid;

const OTHER_ORG: Uuid = Uuid::from_u128(0x5ea5_5ea5_5ea5_5ea5_5ea5_5ea5_5ea5_5ea5);

async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    for grant in [
        "GRANT SELECT, INSERT, UPDATE ON leave_requests TO mnt_rt",
        "GRANT SELECT, INSERT, UPDATE ON leave_promotions TO mnt_rt",
        "GRANT SELECT, INSERT, UPDATE ON inbox_docs TO mnt_rt",
        "GRANT SELECT, INSERT ON audit_events TO mnt_rt",
        "GRANT SELECT, UPDATE ON employees TO mnt_rt",
        "GRANT SELECT ON users TO mnt_rt",
        "GRANT SELECT ON branches TO mnt_rt",
        "GRANT SELECT ON organizations TO mnt_rt",
    ] {
        sqlx::query(grant).execute(owner_pool).await.unwrap();
    }
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
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
    )
    .bind(org)
    .bind(format!("org-{}", tag.to_lowercase()))
    .bind(format!("Org {tag}"))
    .execute(owner_pool)
    .await
    .unwrap();
}

async fn seed_branch(owner_pool: &PgPool, org: Uuid) -> Uuid {
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    let region_id: Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(format!("Region {}", Uuid::new_v4()))
            .bind(org)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    let branch_id: Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(region_id)
    .bind(format!("Branch {}", Uuid::new_v4()))
    .bind(org)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    branch_id
}

async fn seed_user(owner_pool: &PgPool, org: Uuid) -> UserId {
    let user_id = UserId::new();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id, is_active) \
         VALUES ($1, $2, $3, $4, true)",
    )
    .bind(user_id.as_uuid())
    .bind(format!("User {}", Uuid::new_v4()))
    .bind(vec!["ADMIN".to_string()])
    .bind(org)
    .execute(owner_pool)
    .await
    .unwrap();
    user_id
}

async fn seed_employee(
    owner_pool: &PgPool,
    org: Uuid,
    grant: f64,
    used: f64,
    remaining: f64,
) -> Uuid {
    let id = Uuid::new_v4();
    let key = format!("emp-{id}");
    sqlx::query(
        "INSERT INTO employees \
         (id, org_id, company, name, source_filename, source_sheet, source_row, source_key, \
          leave_accrued, leave_used, leave_remaining) \
         VALUES ($1, $2, 'KNL', $3, 'roster.xlsx', 'Sheet1', 1, $4, $5, $6, $7)",
    )
    .bind(id)
    .bind(org)
    .bind(format!("Employee {id}"))
    .bind(key)
    .bind(grant)
    .bind(used)
    .bind(remaining)
    .execute(owner_pool)
    .await
    .unwrap();
    id
}

fn date(y: i32, m: u8, d: u8) -> mnt_kernel_core::Date {
    mnt_kernel_core::Date::from_calendar_date(y, Month::try_from(m).unwrap(), d).unwrap()
}

fn create_cmd(
    branch: Uuid,
    requester: UserId,
    subject: Uuid,
    days: f64,
) -> CreateLeaveRequestCommand {
    CreateLeaveRequestCommand {
        branch_id: branch,
        requester_user_id: requester,
        subject_employee_id: subject,
        leave_type: LeaveType::Annual,
        days,
        start_date: date(2026, 7, 6),
        end_date: date(2026, 7, 8),
        reason: "여름 휴가".to_owned(),
        trace: TraceContext::generate(),
        occurred_at: OffsetDateTime::now_utc(),
    }
}

fn decide_cmd(
    request_id: mnt_kernel_core::LeaveRequestId,
    decider: UserId,
    scope: BranchScope,
    decision: LeaveDecision,
) -> DecideLeaveRequestCommand {
    DecideLeaveRequestCommand {
        request_id,
        decider,
        branch_scope: scope,
        decision,
        comment: if decision == LeaveDecision::Approve {
            None
        } else {
            Some("사유 보완 필요".to_owned())
        },
        trace: TraceContext::generate(),
        occurred_at: OffsetDateTime::now_utc(),
    }
}

fn scope_of(branch: Uuid) -> BranchScope {
    BranchScope::Branches(BTreeSet::from([BranchId::from_uuid(branch)]))
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn approve_writes_ledger_and_enforces_sod_branch_and_tenant(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let knl = OrgId::knl();
    let knl_uuid = *knl.as_uuid();
    let other = OrgId::from_uuid(OTHER_ORG);
    seed_org(&owner_pool, OTHER_ORG, "Other").await;

    let branch_a = seed_branch(&owner_pool, knl_uuid).await;
    let branch_b = seed_branch(&owner_pool, knl_uuid).await;
    let requester = seed_user(&owner_pool, knl_uuid).await;
    let approver = seed_user(&owner_pool, knl_uuid).await;
    let employee = seed_employee(&owner_pool, knl_uuid, 15.0, 0.0, 15.0).await;

    let store = PgLeaveStore::new(rt.clone(), Arc::new(PgInboxStore::new(rt.clone())));

    let request = mnt_platform_request_context::scope_org(knl, async {
        store
            .create_request(create_cmd(branch_a, requester, employee, 3.0))
            .await
    })
    .await
    .expect("create request");
    assert_eq!(request.status, LeaveStatus::Pending);

    // SoD: the requester cannot decide their own request.
    let sod = mnt_platform_request_context::scope_org(knl, async {
        store
            .decide(decide_cmd(
                request.id,
                requester,
                scope_of(branch_a),
                LeaveDecision::Approve,
            ))
            .await
    })
    .await;
    assert_eq!(
        sod.expect_err("self-decision must fail").kind(),
        ErrorKind::Forbidden,
        "a requester cannot approve their own leave (SoD)"
    );

    // Branch isolation: an approver scoped to branch B cannot see branch A's
    // request — deny-by-omission (NotFound), not a leak.
    let cross_branch = mnt_platform_request_context::scope_org(knl, async {
        store
            .decide(decide_cmd(
                request.id,
                approver,
                scope_of(branch_b),
                LeaveDecision::Approve,
            ))
            .await
    })
    .await;
    assert_eq!(
        cross_branch
            .expect_err("out-of-branch decide must fail")
            .kind(),
        ErrorKind::NotFound,
    );

    // Approve in-branch: status flips AND the ledger moves in the same tx.
    let approved = mnt_platform_request_context::scope_org(knl, async {
        store
            .decide(decide_cmd(
                request.id,
                approver,
                scope_of(branch_a),
                LeaveDecision::Approve,
            ))
            .await
    })
    .await
    .expect("in-branch approve");
    assert_eq!(approved.status, LeaveStatus::Approved);
    assert_eq!(approved.decided_by, Some(approver));

    let (used, remaining): (f64, f64) = sqlx::query_as(
        "SELECT leave_used::float8, leave_remaining::float8 FROM employees WHERE id = $1",
    )
    .bind(employee)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert!(
        (used - 3.0).abs() < f64::EPSILON,
        "approve adds the days to used"
    );
    assert!(
        (remaining - 12.0).abs() < f64::EPSILON,
        "approve subtracts the days from remaining"
    );

    // Re-decide is a conflict (no double ledger write).
    let again = mnt_platform_request_context::scope_org(knl, async {
        store
            .decide(decide_cmd(
                request.id,
                approver,
                scope_of(branch_a),
                LeaveDecision::Reject,
            ))
            .await
    })
    .await;
    assert_eq!(
        again.expect_err("re-decide must fail").kind(),
        ErrorKind::Conflict
    );

    // Queue: in-branch scope sees it; empty scope sees nothing; other tenant
    // sees nothing.
    let in_branch = mnt_platform_request_context::scope_org(knl, async {
        store
            .list_requests(ListLeaveRequestsQuery {
                branch_scope: scope_of(branch_a),
                status: None,
                limit: 50,
            })
            .await
    })
    .await
    .unwrap();
    assert_eq!(in_branch.items.len(), 1);

    let empty_scope = mnt_platform_request_context::scope_org(knl, async {
        store
            .list_requests(ListLeaveRequestsQuery {
                branch_scope: BranchScope::Branches(BTreeSet::new()),
                status: None,
                limit: 50,
            })
            .await
    })
    .await
    .unwrap();
    assert!(
        empty_scope.items.is_empty(),
        "an empty branch scope sees nothing (deny-by-omission)"
    );

    let cross_tenant = mnt_platform_request_context::scope_org(other, async {
        store
            .list_requests(ListLeaveRequestsQuery {
                branch_scope: BranchScope::All,
                status: None,
                limit: 50,
            })
            .await
    })
    .await
    .unwrap();
    assert!(
        cross_tenant.items.is_empty(),
        "another tenant sees none of the requests (RLS)"
    );

    // Balances roster reflects the moved ledger.
    let balances =
        mnt_platform_request_context::scope_org(knl, async { store.list_balances().await })
            .await
            .unwrap();
    let row = balances
        .items
        .iter()
        .find(|b| b.employee_id == employee)
        .expect("employee in balances");
    assert!((row.used - 3.0).abs() < f64::EPSILON);
    assert!((row.left - 12.0).abs() < f64::EPSILON);
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn statutory_push_delivers_receipt_doc_and_is_idempotent(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let knl = OrgId::knl();
    let knl_uuid = *knl.as_uuid();
    let branch = seed_branch(&owner_pool, knl_uuid).await;
    let actor = seed_user(&owner_pool, knl_uuid).await;
    let target = seed_user(&owner_pool, knl_uuid).await;
    let target_emp = seed_employee(&owner_pool, knl_uuid, 15.0, 2.0, 13.0).await;

    let store = PgLeaveStore::new(rt.clone(), Arc::new(PgInboxStore::new(rt.clone())));

    let push = |kind: PromotionKind, round: i16| {
        let store = store.clone();
        async move {
            mnt_platform_request_context::scope_org(knl, async move {
                store
                    .statutory_push(StatutoryPushCommand {
                        actor,
                        branch_id: branch,
                        target_user_id: target,
                        target_employee_id: target_emp,
                        target_name: "홍길동".to_owned(),
                        kind,
                        round,
                        unused_days: 13.0,
                        trace: TraceContext::generate(),
                        occurred_at: OffsetDateTime::now_utc(),
                    })
                    .await
            })
            .await
        }
    };

    // Round-1 promotion: delivers a locked legal notice + records the push.
    let r1 = push(PromotionKind::Promotion, 1)
        .await
        .expect("round 1 push");
    assert_eq!(r1.kind, PromotionKind::Promotion);
    assert_eq!(r1.round, 1);
    assert!(r1.ap_run_id.is_none());
    assert_eq!(r1.ap_submission, "pending_engine_definition");

    // The delivered notice is a LOCKED legal notice for the target.
    let (kind, notice_type, recipient): (String, Option<String>, Uuid) =
        sqlx::query_as("SELECT kind, notice_type, recipient_user_id FROM inbox_docs WHERE id = $1")
            .bind(r1.inbox_doc_id)
            .fetch_one(&owner_pool)
            .await
            .unwrap();
    assert_eq!(kind, "legal_notice");
    assert_eq!(notice_type.as_deref(), Some("연차촉진"));
    assert_eq!(recipient, *target.as_uuid());

    // Idempotent: a second round-1 push returns the same promotion row and does
    // NOT double-deliver the notice.
    let r1_again = push(PromotionKind::Promotion, 1)
        .await
        .expect("round 1 again");
    assert_eq!(r1_again.id, r1.id, "duplicate push is idempotent");
    let promo_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM leave_promotions WHERE target_employee_id = $1 AND kind = 'promotion' AND round = 1",
    )
    .bind(target_emp)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(promo_count, 1, "no duplicate promotion row");
    let doc_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM inbox_docs WHERE recipient_user_id = $1 AND notice_type = '연차촉진'",
    )
    .bind(target.as_uuid())
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(doc_count, 1, "dedup: the notice is delivered exactly once");

    // Round 2 then refusal are distinct pushes.
    let r2 = push(PromotionKind::Promotion, 2).await.expect("round 2");
    assert_eq!(r2.round, 2);
    assert_ne!(r2.id, r1.id);
    let refusal = push(PromotionKind::Refusal, 0).await.expect("refusal");
    assert_eq!(refusal.kind, PromotionKind::Refusal);
    assert_eq!(refusal.round, 2, "a refusal follows round 2");

    let total_promotions: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM leave_promotions WHERE target_employee_id = $1")
            .bind(target_emp)
            .fetch_one(&owner_pool)
            .await
            .unwrap();
    assert_eq!(total_promotions, 3, "round1 + round2 + refusal");
}
