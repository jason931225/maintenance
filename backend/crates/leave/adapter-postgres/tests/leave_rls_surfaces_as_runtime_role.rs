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
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use mnt_governance_domain::{GateChainConfig, GateEvidence, evaluate_gate_chain};
use mnt_inbox_adapter_postgres::PgInboxStore;
use mnt_kernel_core::{BranchId, BranchScope, ErrorKind, OrgId, TraceContext, UserId};
use mnt_leave_adapter_postgres::PgLeaveStore;
use mnt_leave_application::{
    ApSubmission, CreateLeaveRequestCommand, DecideLeaveRequestCommand, ListLeaveRequestsQuery,
    ListSelfLeaveRequestsQuery, ResolveLeaveChargeCommand, ResolveLeaveChargeQuery,
    StatutoryPushCommand, WorkCalendarPort,
};
use mnt_leave_domain::{
    LeaveChargeAssessment, LeaveChargeEvidence, LeaveChargeState, LeaveDateCharge, LeaveDecision,
    LeaveStatus, LeaveType, LeaveUnits, NewLeaveRequest, PromotionKind, SourceRevisionRef,
    WorkObligation,
};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use time::{Month, OffsetDateTime};
use uuid::Uuid;

const OTHER_ORG: Uuid = Uuid::from_u128(0x5ea5_5ea5_5ea5_5ea5_5ea5_5ea5_5ea5_5ea5);

fn f6ff_apply_after_snap(run_id: Uuid) -> serde_json::Value {
    let gate_outcome = serde_json::to_value(evaluate_gate_chain(
        GateChainConfig {
            self_checklist: true,
            ..GateChainConfig::default()
        },
        &GateEvidence {
            checklist_all_acknowledged: Some(true),
            ..GateEvidence::default()
        },
    ))
    .unwrap();
    assert_eq!(
        gate_outcome,
        serde_json::json!({
            "gates": [
                {"gate": "authority", "status": {"status": "not_required"}},
                {"gate": "self_checklist", "status": {"status": "satisfied"}},
                {"gate": "four_eyes", "status": {"status": "not_required"}},
                {"gate": "egress_dlp", "status": {"status": "not_required"}}
            ],
            "allow": true
        }),
        "the legacy audit envelope must track the actual GateOutcome serde shape"
    );
    serde_json::json!({
        "run_id": run_id,
        "entity_type": "employee_hr",
        "gate_outcome": gate_outcome
    })
}

async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    for grant in [
        "GRANT SELECT, INSERT, UPDATE ON leave_requests TO mnt_rt",
        "GRANT SELECT, INSERT ON leave_charge_resolutions TO mnt_rt",
        "GRANT SELECT, INSERT, UPDATE ON leave_promotions TO mnt_rt",
        "GRANT SELECT, INSERT, UPDATE ON inbox_docs TO mnt_rt",
        "GRANT SELECT, INSERT ON audit_events TO mnt_rt",
        "GRANT SELECT, INSERT, UPDATE ON employees TO mnt_rt",
        "GRANT SELECT ON users TO mnt_rt",
        "GRANT SELECT ON user_branches TO mnt_rt",
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

async fn leave_command_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(4)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET ROLE mnt_leave_cmd").execute(conn).await?;
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

async fn link_user_to_branch(owner_pool: &PgPool, org: Uuid, user: UserId, branch: Uuid) {
    sqlx::query(
        "INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3) \
         ON CONFLICT DO NOTHING",
    )
    .bind(user.as_uuid())
    .bind(branch)
    .bind(org)
    .execute(owner_pool)
    .await
    .unwrap();
}

async fn link_user_to_employee_and_branch(
    owner_pool: &PgPool,
    org: Uuid,
    user: UserId,
    employee: Uuid,
    branch: Uuid,
) {
    sqlx::query("UPDATE users SET employee_id = $2 WHERE id = $1 AND org_id = $3")
        .bind(user.as_uuid())
        .bind(employee)
        .bind(org)
        .execute(owner_pool)
        .await
        .unwrap();
    link_user_to_branch(owner_pool, org, user, branch).await;
    let routing_admin = UserId::new();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id, is_active) \
         VALUES ($1, $2, ARRAY['SUPER_ADMIN']::text[], $3, true)",
    )
    .bind(routing_admin.as_uuid())
    .bind(format!("Routing admin {}", Uuid::new_v4()))
    .bind(org)
    .execute(owner_pool)
    .await
    .unwrap();
    let expected: OffsetDateTime =
        sqlx::query_scalar("SELECT updated_at FROM employees WHERE id = $1 AND org_id = $2")
            .bind(employee)
            .bind(org)
            .fetch_one(owner_pool)
            .await
            .unwrap();
    let mut command = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE mnt_leave_cmd")
        .execute(&mut *command)
        .await
        .unwrap();
    sqlx::query(
        "SELECT * FROM leave_api.set_employee_home_branch(\
         $1,$2,$3,$4,$5,$6,$7)",
    )
    .bind(org)
    .bind(employee)
    .bind(branch)
    .bind(expected)
    .bind(routing_admin.as_uuid())
    .bind("0123456789abcdef0123456789abcdef")
    .bind("0123456789abcdef")
    .fetch_one(&mut *command)
    .await
    .unwrap();
    command.commit().await.unwrap();
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
    let mut command = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE mnt_leave_definer")
        .execute(&mut *command)
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(&mut *command)
        .await
        .unwrap();
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
    .execute(&mut *command)
    .await
    .unwrap();
    command.commit().await.unwrap();
    id
}

fn date(y: i32, m: u8, d: u8) -> mnt_kernel_core::Date {
    mnt_kernel_core::Date::from_calendar_date(y, Month::try_from(m).unwrap(), d).unwrap()
}

fn create_cmd(
    _branch: Uuid,
    requester: UserId,
    subject: Uuid,
    _days: f64,
) -> CreateLeaveRequestCommand {
    CreateLeaveRequestCommand {
        requester_user_id: requester,
        subject_employee_id: subject,
        idempotency_key: Uuid::new_v4(),
        request: NewLeaveRequest::new(
            LeaveType::Annual,
            date(2026, 7, 6),
            date(2026, 7, 8),
            "여름 휴가",
            None,
        )
        .unwrap(),
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
        expected_version: Some(1),
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

#[derive(Debug)]
struct ThreeDayCalendar;

fn resolved_calendar_assessment(
    query: ResolveLeaveChargeQuery,
    revision: &str,
) -> Result<LeaveChargeAssessment, mnt_kernel_core::KernelError> {
    let mut current = query.start_date;
    let mut date_charges = Vec::new();
    loop {
        date_charges.push(LeaveDateCharge {
            date: current,
            obligation: WorkObligation::Scheduled { minutes: 480 },
            units: LeaveUnits::ONE_DAY,
        });
        if current == query.end_date {
            break;
        }
        current = current.next_day().expect("bounded fixture date");
    }
    Ok(LeaveChargeAssessment::Resolved {
        evidence: LeaveChargeEvidence {
            home_branch_id: query.branch_id,
            calendar_revision_ref: SourceRevisionRef::new("test", "calendar", revision)?,
            policy_revision_ref: SourceRevisionRef::new("test", "policy", revision)?,
            supporting_source_refs: Vec::new(),
            date_charges,
        },
    })
}

impl WorkCalendarPort for ThreeDayCalendar {
    fn resolve_charge(
        &self,
        query: ResolveLeaveChargeQuery,
    ) -> mnt_leave_application::LeaveChargeFuture<'_> {
        Box::pin(async move { resolved_calendar_assessment(query, "v1") })
    }
}

#[derive(Debug)]
struct MutableCalendar {
    revision: Arc<AtomicUsize>,
}

impl WorkCalendarPort for MutableCalendar {
    fn resolve_charge(
        &self,
        query: ResolveLeaveChargeQuery,
    ) -> mnt_leave_application::LeaveChargeFuture<'_> {
        let revision = format!("v{}", self.revision.load(Ordering::SeqCst));
        Box::pin(async move { resolved_calendar_assessment(query, &revision) })
    }
}

fn test_store(rt: &PgPool, command: &PgPool) -> PgLeaveStore {
    PgLeaveStore::with_work_calendar(
        rt.clone(),
        Arc::new(PgInboxStore::new(rt.clone())),
        Arc::new(ThreeDayCalendar),
    )
    .with_leave_command_pool(command.clone())
}

fn manual_resolution_command(
    request_id: mnt_kernel_core::LeaveRequestId,
    resolver: UserId,
    branch: Uuid,
    expected_version: i64,
) -> ResolveLeaveChargeCommand {
    ResolveLeaveChargeCommand {
        request_id,
        resolver,
        branch_scope: scope_of(branch),
        expected_version,
        date_charges: vec![
            LeaveDateCharge {
                date: date(2026, 7, 6),
                obligation: WorkObligation::Scheduled { minutes: 480 },
                units: LeaveUnits::ONE_DAY,
            },
            LeaveDateCharge {
                date: date(2026, 7, 7),
                obligation: WorkObligation::Scheduled { minutes: 480 },
                units: LeaveUnits::ONE_DAY,
            },
            LeaveDateCharge {
                date: date(2026, 7, 8),
                obligation: WorkObligation::Scheduled { minutes: 480 },
                units: LeaveUnits::ONE_DAY,
            },
        ],
        calendar_revision_ref: SourceRevisionRef::new("manual", "calendar-doc", "v7").unwrap(),
        policy_revision_ref: SourceRevisionRef::new("manual", "policy-doc", "v3").unwrap(),
        supporting_source_refs: vec![
            SourceRevisionRef::new("evidence", "review-ticket", "1").unwrap(),
        ],
        trace: TraceContext::generate(),
        occurred_at: OffsetDateTime::now_utc(),
    }
}

async fn wait_for_lock_waiters(owner_pool: &PgPool, minimum: i64) {
    for _ in 0..100 {
        let waiting: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_stat_activity \
             WHERE datname = current_database() AND wait_event_type = 'Lock'",
        )
        .fetch_one(owner_pool)
        .await
        .unwrap();
        if waiting >= minimum {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {minimum} database lock waiter(s)");
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn unresolved_charge_is_audited_without_mutation_then_exact_resolution_is_sod_guarded(
    owner_pool: PgPool,
) {
    let rt = runtime_role_pool(&owner_pool).await;
    let command_pool = leave_command_role_pool(&owner_pool).await;
    let org = OrgId::knl();
    let org_uuid = *org.as_uuid();
    let home = seed_branch(&owner_pool, org_uuid).await;
    let secondary = seed_branch(&owner_pool, org_uuid).await;
    let requester = seed_user(&owner_pool, org_uuid).await;
    let resolver = seed_user(&owner_pool, org_uuid).await;
    let approver = seed_user(&owner_pool, org_uuid).await;
    let employee = seed_employee(&owner_pool, org_uuid, 10.0, 0.0, 10.0).await;
    link_user_to_employee_and_branch(&owner_pool, org_uuid, requester, employee, home).await;
    link_user_to_branch(&owner_pool, org_uuid, resolver, home).await;
    link_user_to_branch(&owner_pool, org_uuid, approver, home).await;
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(requester.as_uuid())
        .bind(secondary)
        .bind(org_uuid)
        .execute(&owner_pool)
        .await
        .unwrap();

    let store = PgLeaveStore::new(rt.clone(), Arc::new(PgInboxStore::new(rt.clone())))
        .with_leave_command_pool(command_pool.clone());
    let request = mnt_platform_request_context::scope_org(org, async {
        store
            .create_request(create_cmd(home, requester, employee, 3.0))
            .await
    })
    .await
    .unwrap();
    assert_eq!(
        request.branch_id, home,
        "user_branches never selects routing"
    );
    assert_eq!(request.charge_version, 0);

    let blocked = mnt_platform_request_context::scope_org(org, async {
        store
            .decide(DecideLeaveRequestCommand {
                expected_version: Some(1),
                ..decide_cmd(request.id, approver, scope_of(home), LeaveDecision::Approve)
            })
            .await
    })
    .await
    .expect_err("unresolved approval must fail closed");
    assert!(matches!(
        blocked,
        mnt_leave_adapter_postgres::PgLeaveError::ChargeReviewRequired(_)
    ));
    let (status, request_version, charge_version): (String, i64, i64) = sqlx::query_as(
        "SELECT status, request_version, charge_version FROM leave_requests WHERE id = $1",
    )
    .bind(request.id.as_uuid())
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(
        (status.as_str(), request_version, charge_version),
        ("pending", 1, 0),
        "blocked approval must not consume either version"
    );
    let (resolution_count, used_micros, remaining_micros): (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM leave_charge_resolutions WHERE request_id = $1), \
                (leave_used * 1000000)::bigint, (leave_remaining * 1000000)::bigint \
         FROM employees WHERE id = $2",
    )
    .bind(request.id.as_uuid())
    .bind(employee)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(resolution_count, 0);
    assert_eq!((used_micros, remaining_micros), (0, 10_000_000));
    let blocked_audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE target_id = $1 AND action = 'leave_request.approval_blocked'",
    )
    .bind(request.id.to_string())
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(blocked_audits, 1);

    let resolved = mnt_platform_request_context::scope_org(org, async {
        store
            .resolve_charge(manual_resolution_command(request.id, resolver, home, 1))
            .await
    })
    .await
    .unwrap();
    assert_eq!(resolved.charge_units.micros(), 3_000_000);
    assert_eq!(resolved.request_version, 2);
    assert_eq!(resolved.charge_version, 1);

    let resolver_approve = mnt_platform_request_context::scope_org(org, async {
        store
            .decide(DecideLeaveRequestCommand {
                expected_version: Some(2),
                ..decide_cmd(request.id, resolver, scope_of(home), LeaveDecision::Approve)
            })
            .await
    })
    .await;
    assert_eq!(resolver_approve.unwrap_err().kind(), ErrorKind::Forbidden);

    let approved = mnt_platform_request_context::scope_org(org, async {
        store
            .decide(DecideLeaveRequestCommand {
                expected_version: Some(2),
                ..decide_cmd(request.id, approver, scope_of(home), LeaveDecision::Approve)
            })
            .await
    })
    .await
    .unwrap();
    assert_eq!(approved.request_version, 3);
    assert_eq!(approved.charge_version, 1);
    let remaining_micros: i64 = sqlx::query_scalar(
        "SELECT (leave_remaining * 1000000)::bigint FROM employees WHERE id = $1",
    )
    .bind(employee)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(remaining_micros, 7_000_000);
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn concurrent_resolver_wins_before_blocked_approval_without_partial_mutation(
    owner_pool: PgPool,
) {
    let rt = runtime_role_pool(&owner_pool).await;
    let command_pool = leave_command_role_pool(&owner_pool).await;
    let org = OrgId::knl();
    let org_uuid = *org.as_uuid();
    let home = seed_branch(&owner_pool, org_uuid).await;
    let requester = seed_user(&owner_pool, org_uuid).await;
    let resolver = seed_user(&owner_pool, org_uuid).await;
    let approver = seed_user(&owner_pool, org_uuid).await;
    let employee = seed_employee(&owner_pool, org_uuid, 10.0, 0.0, 10.0).await;
    link_user_to_employee_and_branch(&owner_pool, org_uuid, requester, employee, home).await;
    link_user_to_branch(&owner_pool, org_uuid, resolver, home).await;
    link_user_to_branch(&owner_pool, org_uuid, approver, home).await;

    let store = PgLeaveStore::new(rt.clone(), Arc::new(PgInboxStore::new(rt)))
        .with_leave_command_pool(command_pool.clone());
    let request = mnt_platform_request_context::scope_org(org, async {
        store
            .create_request(create_cmd(home, requester, employee, 3.0))
            .await
    })
    .await
    .unwrap();

    // Hold the request row so both commands finish their optimistic read and
    // queue at their in-transaction SELECT FOR UPDATE. Queue the resolver
    // first: once this lock is released it must win, and the approval must
    // re-check the now-resolved row rather than committing a stale blocked
    // audit or any request/ledger mutation of its own.
    let mut blocker = owner_pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM leave_requests WHERE id = $1 FOR UPDATE")
        .bind(request.id.as_uuid())
        .fetch_one(&mut *blocker)
        .await
        .unwrap();

    let resolving_store = store.clone();
    let resolving = tokio::spawn(async move {
        mnt_platform_request_context::scope_org(org, async move {
            resolving_store
                .resolve_charge(manual_resolution_command(request.id, resolver, home, 1))
                .await
        })
        .await
    });
    wait_for_lock_waiters(&owner_pool, 1).await;

    let deciding_store = store.clone();
    let deciding = tokio::spawn(async move {
        mnt_platform_request_context::scope_org(org, async move {
            deciding_store
                .decide(DecideLeaveRequestCommand {
                    expected_version: Some(1),
                    ..decide_cmd(request.id, approver, scope_of(home), LeaveDecision::Approve)
                })
                .await
        })
        .await
    });
    wait_for_lock_waiters(&owner_pool, 2).await;
    blocker.commit().await.unwrap();

    let resolved = resolving.await.unwrap().unwrap();
    assert_eq!(resolved.charge_units.micros(), 3_000_000);
    assert_eq!(resolved.request_version, 2);
    assert_eq!(resolved.charge_version, 1);
    assert!(matches!(
        deciding.await.unwrap().unwrap_err(),
        mnt_leave_adapter_postgres::PgLeaveError::ConcurrentModification
    ));

    let (status, charge_state, request_version, charge_version, resolution_count, blocked_audits, used_micros, remaining_micros):
        (String, String, i64, i64, i64, i64, i64, i64) = sqlx::query_as(
            "SELECT lr.status, lr.charge_state, lr.request_version, lr.charge_version, \
                    (SELECT count(*) FROM leave_charge_resolutions lcr WHERE lcr.request_id = lr.id), \
                    (SELECT count(*) FROM audit_events ae WHERE ae.target_id = lr.id::text \
                        AND ae.action = 'leave_request.approval_blocked'), \
                    (e.leave_used * 1000000)::bigint, \
                    (e.leave_remaining * 1000000)::bigint \
             FROM leave_requests lr JOIN employees e ON e.id = lr.subject_employee_id \
             WHERE lr.id = $1",
        )
        .bind(request.id.as_uuid())
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    assert_eq!(
        (
            status.as_str(),
            charge_state.as_str(),
            request_version,
            charge_version,
        ),
        ("pending", "resolved", 2, 1)
    );
    assert_eq!(resolution_count, 1);
    assert_eq!(blocked_audits, 0, "stale blocked audit must roll back");
    assert_eq!((used_micros, remaining_micros), (0, 10_000_000));
}

fn scope_of(branch: Uuid) -> BranchScope {
    BranchScope::Branches(BTreeSet::from([BranchId::from_uuid(branch)]))
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn request_cas_and_charge_evidence_versions_are_independent_and_exact(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let command_pool = leave_command_role_pool(&owner_pool).await;
    let org = OrgId::knl();
    let org_uuid = *org.as_uuid();
    let branch = seed_branch(&owner_pool, org_uuid).await;
    let requester = seed_user(&owner_pool, org_uuid).await;
    let resolver = seed_user(&owner_pool, org_uuid).await;
    let approver = seed_user(&owner_pool, org_uuid).await;
    let employee = seed_employee(&owner_pool, org_uuid, 10.0, 0.0, 10.0).await;
    link_user_to_employee_and_branch(&owner_pool, org_uuid, requester, employee, branch).await;
    for actor in [resolver, approver] {
        sqlx::query("INSERT INTO user_branches (user_id,branch_id,org_id) VALUES ($1,$2,$3)")
            .bind(actor.as_uuid())
            .bind(branch)
            .bind(org_uuid)
            .execute(&owner_pool)
            .await
            .unwrap();
    }
    let store = test_store(&rt, &command_pool);
    let created = mnt_platform_request_context::scope_org(org, async {
        store
            .create_request(create_cmd(branch, requester, employee, 3.0))
            .await
    })
    .await
    .unwrap();
    assert_eq!((created.request_version, created.charge_version), (1, 1));

    let resolved = mnt_platform_request_context::scope_org(org, async {
        store
            .resolve_charge(manual_resolution_command(created.id, requester, branch, 1))
            .await
    })
    .await;
    // The requester cannot resolve their own request; this failed command must
    // not consume either request or evidence versions.
    assert_eq!(resolved.unwrap_err().kind(), ErrorKind::Forbidden);
    let resolved = mnt_platform_request_context::scope_org(org, async {
        store
            .resolve_charge(manual_resolution_command(created.id, resolver, branch, 1))
            .await
    })
    .await
    .unwrap();
    assert_eq!((resolved.request_version, resolved.charge_version), (2, 2));

    let stale = mnt_platform_request_context::scope_org(org, async {
        store
            .decide(DecideLeaveRequestCommand {
                expected_version: Some(1),
                ..decide_cmd(
                    created.id,
                    approver,
                    scope_of(branch),
                    LeaveDecision::Approve,
                )
            })
            .await
    })
    .await;
    assert!(matches!(
        stale,
        Err(mnt_leave_adapter_postgres::PgLeaveError::ConcurrentModification)
    ));

    let old_resolution: Uuid = sqlx::query_scalar(
        "SELECT id FROM leave_charge_resolutions WHERE request_id=$1 AND charge_version=1",
    )
    .bind(created.id.as_uuid())
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    let mut forged_pointer = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE mnt_leave_definer")
        .execute(&mut *forged_pointer)
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org_uuid.to_string())
        .execute(&mut *forged_pointer)
        .await
        .unwrap();
    assert!(
        sqlx::query("UPDATE leave_requests SET current_charge_resolution_id=$2 WHERE id=$1")
            .bind(created.id.as_uuid())
            .bind(old_resolution)
            .execute(&mut *forged_pointer)
            .await
            .is_err(),
        "a current pointer to older evidence must fail exact-version validation"
    );
    forged_pointer.rollback().await.unwrap();

    let approved = mnt_platform_request_context::scope_org(org, async {
        store
            .decide(DecideLeaveRequestCommand {
                expected_version: Some(2),
                ..decide_cmd(
                    created.id,
                    approver,
                    scope_of(branch),
                    LeaveDecision::Approve,
                )
            })
            .await
    })
    .await
    .unwrap();
    assert_eq!((approved.request_version, approved.charge_version), (3, 2));
    let (request_charge, pointed_charge): (i64, i64) = sqlx::query_as(
        "SELECT lr.charge_version,lcr.charge_version FROM leave_requests lr \
         JOIN leave_charge_resolutions lcr ON lcr.id=lr.current_charge_resolution_id \
         WHERE lr.id=$1",
    )
    .bind(created.id.as_uuid())
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(
        request_charge, pointed_charge,
        "decision preserves exact evidence pointer"
    );
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn leave_command_preprovision_and_privilege_matrix_are_fail_closed(owner_pool: PgPool) {
    let cmd = sqlx::query(
        "SELECT rolcanlogin,rolsuper,rolbypassrls,rolinherit,rolcreatedb,rolcreaterole,rolreplication \
         FROM pg_roles WHERE rolname='mnt_leave_cmd'",
    )
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert!(
        cmd.get::<bool, _>("rolcanlogin"),
        "managed LOGIN is preserved"
    );
    for attribute in [
        "rolsuper",
        "rolbypassrls",
        "rolinherit",
        "rolcreatedb",
        "rolcreaterole",
        "rolreplication",
    ] {
        assert!(
            !cmd.get::<bool, _>(attribute),
            "cmd {attribute} must be false"
        );
    }
    let definer = sqlx::query(
        "SELECT rolcanlogin,rolsuper,rolbypassrls,rolinherit,rolcreatedb,rolcreaterole,rolreplication \
         FROM pg_roles WHERE rolname='mnt_leave_definer'",
    )
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    for attribute in [
        "rolcanlogin",
        "rolsuper",
        "rolbypassrls",
        "rolinherit",
        "rolcreatedb",
        "rolcreaterole",
        "rolreplication",
    ] {
        assert!(
            !definer.get::<bool, _>(attribute),
            "definer {attribute} must be false"
        );
    }
    let command_can_assume_definer: bool =
        sqlx::query_scalar("SELECT pg_has_role('mnt_leave_cmd','mnt_leave_definer','MEMBER')")
            .fetch_one(&owner_pool)
            .await
            .unwrap();
    assert!(
        !command_can_assume_definer,
        "command role must not inherit or assume the definer"
    );
    let migrator_membership: (bool, bool, bool) = sqlx::query_as(
        "SELECT am.admin_option,am.inherit_option,am.set_option \
         FROM pg_auth_members am \
         WHERE am.roleid='mnt_leave_definer'::regrole AND am.member='mnt_app'::regrole",
    )
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(
        migrator_membership,
        (false, true, true),
        "mnt_app receives the exact non-admin ownership edge"
    );

    let command_functions: Vec<String> = sqlx::query_scalar(
        "SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace \
         WHERE n.nspname='leave_api' \
           AND has_function_privilege('mnt_leave_cmd',p.oid,'EXECUTE') ORDER BY p.proname",
    )
    .fetch_all(&owner_pool)
    .await
    .unwrap();
    assert_eq!(
        command_functions,
        vec![
            "apply_employee_import_batch".to_owned(),
            "create_request".to_owned(),
            "decide_request".to_owned(),
            "import_employee_leave_balance".to_owned(),
            "resolve_charge".to_owned(),
            "set_employee_home_branch".to_owned(),
        ],
        "command role receives exactly six public entrypoints and no helpers"
    );
    let runtime_execute_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace \
         WHERE n.nspname='leave_api' AND has_function_privilege('mnt_rt',p.oid,'EXECUTE')",
    )
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(
        runtime_execute_count, 0,
        "mnt_rt executes no leave command or helper"
    );
    let public_execute_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace, \
                LATERAL aclexplode(p.proacl) acl \
         WHERE n.nspname='leave_api' AND acl.grantee=0 AND acl.privilege_type='EXECUTE'",
    )
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(public_execute_count, 0, "PUBLIC executes no leave function");
    let (
        cmd_schema,
        rt_schema,
        cmd_request_insert,
        rt_request_insert,
        cmd_request_update,
        rt_request_update,
        cmd_request_delete,
        rt_request_delete,
        cmd_request_truncate,
        rt_request_truncate,
        cmd_resolution_dml,
        rt_resolution_dml,
    ): (bool, bool, bool, bool, bool, bool, bool, bool, bool, bool, bool, bool) = sqlx::query_as(
            "SELECT has_schema_privilege('mnt_leave_cmd','leave_api','USAGE'), \
                    has_schema_privilege('mnt_rt','leave_api','USAGE'), \
                    has_table_privilege('mnt_leave_cmd','leave_requests','INSERT'), \
                    has_table_privilege('mnt_rt','leave_requests','INSERT'), \
                    has_table_privilege('mnt_leave_cmd','leave_requests','UPDATE'), \
                    has_table_privilege('mnt_rt','leave_requests','UPDATE'), \
                    has_table_privilege('mnt_leave_cmd','leave_requests','DELETE'), \
                    has_table_privilege('mnt_rt','leave_requests','DELETE'), \
                    has_table_privilege('mnt_leave_cmd','leave_requests','TRUNCATE'), \
                    has_table_privilege('mnt_rt','leave_requests','TRUNCATE'), \
                    has_table_privilege('mnt_leave_cmd','leave_charge_resolutions','INSERT,UPDATE,DELETE,TRUNCATE'), \
                    has_table_privilege('mnt_rt','leave_charge_resolutions','INSERT,UPDATE,DELETE,TRUNCATE')",
        )
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    assert!(cmd_schema);
    assert!(!rt_schema);
    assert!(
        !cmd_request_insert && !cmd_request_update && rt_request_insert && rt_request_update,
        "only mnt_rt retains both guarded legacy INSERT and UPDATE expand bridges"
    );
    assert!(
        !cmd_request_delete && !rt_request_delete && !cmd_request_truncate && !rt_request_truncate
    );
    assert!(!cmd_resolution_dml && !rt_resolution_dml);
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn runtime_expand_bridge_allows_exact_f6ff_apply_but_denies_laundering_and_replay(
    owner_pool: PgPool,
) {
    let rt = runtime_role_pool(&owner_pool).await;
    let org_id = Uuid::new_v4();
    let actor_id = Uuid::new_v4();
    let run_id = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id,slug,name) VALUES ($1,$2,'Import guard test')")
        .bind(org_id)
        .bind(format!("import-guard-{}", &org_id.to_string()[..8]))
        .execute(&owner_pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO users (id,display_name,roles,is_active,org_id) \
         VALUES ($1,'Import guard actor',ARRAY['SUPER_ADMIN']::text[],true,$2)",
    )
    .bind(actor_id)
    .bind(org_id)
    .execute(&owner_pool)
    .await
    .unwrap();

    let mut direct = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org_id.to_string())
        .execute(&mut *direct)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO data_import_runs \
         (id,org_id,entity_type,status,source_filename,source_format,source_sha256) \
         VALUES ($1,$2,'employee_hr','DRY_RUN','employees.xlsx','xlsx',$3)",
    )
    .bind(run_id)
    .bind(org_id)
    .bind("a".repeat(64))
    .execute(&mut *direct)
    .await
    .unwrap();
    direct.commit().await.unwrap();

    // The original laundering sequence cannot even leave employee_hr. This
    // closes employee_hr -> attendance_direct -> forged APPLIED fields ->
    // employee_hr before any protected terminal data can be staged.
    let mut launder_kind = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org_id.to_string())
        .execute(&mut *launder_kind)
        .await
        .unwrap();
    assert!(
        sqlx::query(
            "UPDATE data_import_runs SET entity_type='attendance_direct' \
             WHERE org_id=$1 AND id=$2",
        )
        .bind(org_id)
        .bind(run_id)
        .execute(&mut *launder_kind)
        .await
        .is_err(),
        "employee_hr must not be relabeled before forging attendance apply fields"
    );
    launder_kind.rollback().await.unwrap();

    // Expand compatibility preserves the exact f6ff ordering: a staged
    // employee_hr DRY_RUN becomes APPLIED, then with_audit appends the run-level
    // data_import.apply event in the same transaction. The new binary does not
    // use this raw-table path; a later numbered contract migration removes it
    // after f6ff is outside the rollback set.
    let mut legacy_apply = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org_id.to_string())
        .execute(&mut *legacy_apply)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE data_import_runs SET status='APPLIED',apply_summary=$3,\
         applied_by=$4,applied_at=now(),updated_at=now() WHERE org_id=$1 AND id=$2",
    )
    .bind(org_id)
    .bind(run_id)
    .bind(serde_json::json!({"inserted": 1}))
    .bind(actor_id)
    .execute(&mut *legacy_apply)
    .await
    .expect("the exact f6ff DRY_RUN to APPLIED transition must survive the expand release");
    sqlx::query(
        "INSERT INTO audit_events \
         (actor,action,target_type,target_id,before_snap,after_snap,trace_id,span_id,occurred_at,org_id) \
         VALUES ($1,'data_import.apply','data_import_run',$2,NULL,$3,$4,$5,now(),$6)",
    )
    .bind(actor_id)
    .bind(run_id.to_string())
    .bind(f6ff_apply_after_snap(run_id))
    .bind("0123456789abcdef0123456789abcdef")
    .bind("0123456789abcdef")
    .bind(org_id)
    .execute(&mut *legacy_apply)
    .await
    .expect("the exact same-transaction f6ff apply audit must survive the expand release");
    legacy_apply.commit().await.unwrap();

    let state: (
        String,
        serde_json::Value,
        Option<Uuid>,
        Option<OffsetDateTime>,
        i64,
    ) = sqlx::query_as(
        "SELECT status,apply_summary,applied_by,applied_at,\
             (SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='data_import.apply') \
             FROM data_import_runs WHERE org_id=$1 AND id=$2",
    )
    .bind(org_id)
    .bind(run_id)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(state.0, "APPLIED");
    assert_eq!(state.1, serde_json::json!({"inserted": 1}));
    assert_eq!(state.2, Some(actor_id));
    assert!(state.3.is_some());
    assert_eq!(state.4, 1);

    // The bridge is one exact transition, not continuing terminal authority.
    // A later mnt_rt statement cannot rewrite the committed result.
    let mut terminal_rewrite = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org_id.to_string())
        .execute(&mut *terminal_rewrite)
        .await
        .unwrap();
    assert!(
        sqlx::query(
            "UPDATE data_import_runs SET apply_summary='{}'::jsonb,updated_at=now() \
             WHERE org_id=$1 AND id=$2",
        )
        .bind(org_id)
        .bind(run_id)
        .execute(&mut *terminal_rewrite)
        .await
        .is_err(),
        "the expand bridge must not permit terminal result rewrites"
    );
    terminal_rewrite.rollback().await.unwrap();

    // The audit bridge is anchored to an APPLIED row changed by the current
    // transaction, so delayed/replayed evidence is denied.
    sqlx::query("SELECT set_config('app.current_org',$1,false)")
        .bind(org_id.to_string())
        .execute(&rt)
        .await
        .unwrap();
    assert!(
        sqlx::query(
            "INSERT INTO audit_events \
             (actor,action,target_type,target_id,before_snap,after_snap,trace_id,span_id,occurred_at,org_id) \
             VALUES ($1,'data_import.apply','data_import_run',$2,NULL,$3,$4,$5,now(),$6)",
        )
        .bind(actor_id)
        .bind(run_id.to_string())
        .bind(f6ff_apply_after_snap(run_id))
        .bind("1123456789abcdef0123456789abcdef")
        .bind("1123456789abcdef")
        .bind(org_id)
        .execute(&rt)
        .await
        .is_err(),
        "a delayed or replayed legacy apply audit must remain denied"
    );
    assert!(
        sqlx::query(
            "INSERT INTO audit_events \
             (actor,action,target_type,target_id,trace_id,span_id,occurred_at,org_id) \
             VALUES ($1,'employee.leave_balance_import','employee',$2,$3,$4,now(),$5)",
        )
        .bind(actor_id)
        .bind(Uuid::new_v4().to_string())
        .bind("2123456789abcdef0123456789abcdef")
        .bind("2123456789abcdef")
        .bind(org_id)
        .execute(&rt)
        .await
        .is_err(),
        "command-owned employee balance audit actions remain denied to mnt_rt"
    );
    assert!(
        sqlx::query(
            "INSERT INTO leave_balance_import_receipts \
             (org_id,employee_id,source_kind,source_ref,idempotency_key,payload_digest, \
              result_updated_at,changed,actor,trace_id,span_id) \
             VALUES ($1,$2,'employee_import','forged','0123456789abcdef',repeat('a',64), \
                     now(),true,$3,'3123456789abcdef0123456789abcdef','3123456789abcdef')",
        )
        .bind(org_id)
        .bind(Uuid::new_v4())
        .bind(actor_id)
        .execute(&rt)
        .await
        .is_err(),
        "receipt-table evidence remains command-only"
    );

    // Preserve legitimate attendance apply, then prove the inverse laundering
    // edge is also closed after those otherwise-valid terminal fields exist.
    let attendance_run_id = Uuid::new_v4();
    let mut legitimate_attendance = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org_id.to_string())
        .execute(&mut *legitimate_attendance)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO data_import_runs \
         (id,org_id,entity_type,status,source_filename,source_format,source_sha256) \
         VALUES ($1,$2,'attendance_direct','DRY_RUN','attendance.xlsx','xlsx',$3)",
    )
    .bind(attendance_run_id)
    .bind(org_id)
    .bind("b".repeat(64))
    .execute(&mut *legitimate_attendance)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE data_import_runs SET status='APPLIED',apply_summary=$3,\
         applied_by=$4,applied_at=now() WHERE org_id=$1 AND id=$2",
    )
    .bind(org_id)
    .bind(attendance_run_id)
    .bind(serde_json::json!({"inserted": 1}))
    .bind(actor_id)
    .execute(&mut *legitimate_attendance)
    .await
    .unwrap();
    legitimate_attendance.commit().await.unwrap();

    let mut launder_back = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org_id.to_string())
        .execute(&mut *launder_back)
        .await
        .unwrap();
    assert!(
        sqlx::query(
            "UPDATE data_import_runs SET entity_type='employee_hr' \
             WHERE org_id=$1 AND id=$2",
        )
        .bind(org_id)
        .bind(attendance_run_id)
        .execute(&mut *launder_back)
        .await
        .is_err(),
        "applied attendance evidence must not be relabeled as employee_hr"
    );
    launder_back.rollback().await.unwrap();
    let attendance_kind: String =
        sqlx::query_scalar("SELECT entity_type FROM data_import_runs WHERE id=$1")
            .bind(attendance_run_id)
            .fetch_one(&owner_pool)
            .await
            .unwrap();
    assert_eq!(attendance_kind, "attendance_direct");
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn raw_runtime_home_branch_command_is_guarded_and_intrinsically_audited(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let command_pool = leave_command_role_pool(&owner_pool).await;
    let org = OrgId::knl();
    let org_uuid = *org.as_uuid();
    let branch = seed_branch(&owner_pool, org_uuid).await;
    let actor = seed_user(&owner_pool, org_uuid).await;
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1,$2,$3)")
        .bind(*actor.as_uuid())
        .bind(branch)
        .bind(org_uuid)
        .execute(&owner_pool)
        .await
        .unwrap();
    let super_admin = UserId::new();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id, is_active) \
         VALUES ($1, 'Super admin', ARRAY['SUPER_ADMIN']::text[], $2, true)",
    )
    .bind(super_admin.as_uuid())
    .bind(org_uuid)
    .execute(&owner_pool)
    .await
    .unwrap();
    let employee = seed_employee(&owner_pool, org_uuid, 10.0, 0.0, 10.0).await;
    let expected: OffsetDateTime =
        sqlx::query_scalar("SELECT updated_at FROM employees WHERE id = $1")
            .bind(employee)
            .fetch_one(&owner_pool)
            .await
            .unwrap();

    let mut direct = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org_uuid.to_string())
        .execute(&mut *direct)
        .await
        .unwrap();
    assert!(
        sqlx::query("UPDATE employees SET home_branch_id = $2 WHERE id = $1")
            .bind(employee)
            .bind(branch)
            .execute(&mut *direct)
            .await
            .is_err()
    );
    direct.rollback().await.unwrap();

    let inserted_employee = Uuid::new_v4();
    let mut direct_insert = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org_uuid.to_string())
        .execute(&mut *direct_insert)
        .await
        .unwrap();
    assert!(
        sqlx::query(
            "INSERT INTO employees \
             (id,org_id,company,name,source_filename,source_sheet,source_row,source_key,home_branch_id) \
             VALUES ($1,$2,'KNL','Forged routing','roster.xlsx','Sheet1',1,$3,$4)",
        )
        .bind(inserted_employee)
        .bind(org_uuid)
        .bind(format!("forged-{inserted_employee}"))
        .bind(branch)
        .execute(&mut *direct_insert)
        .await
        .is_err(),
        "mnt_rt must not assign authoritative routing during employee insert"
    );
    direct_insert.rollback().await.unwrap();
    let inserted_count: i64 = sqlx::query_scalar("SELECT count(*) FROM employees WHERE id = $1")
        .bind(inserted_employee)
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    assert_eq!(inserted_count, 0, "denied routing insert must not persist");
    let forged_insert_audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE target_id = $1 AND action = 'employee.home_branch_set'",
    )
    .bind(inserted_employee.to_string())
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(
        forged_insert_audits, 0,
        "denied routing insert must not audit"
    );

    let mut execute_spoof = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org_uuid.to_string())
        .execute(&mut *execute_spoof)
        .await
        .unwrap();
    assert!(
        sqlx::query("SELECT * FROM leave_api.set_employee_home_branch($1,$2,$3,$4,$5,$6,$7)",)
            .bind(org_uuid)
            .bind(employee)
            .bind(branch)
            .bind(expected)
            .bind(actor.as_uuid())
            .bind("0123456789abcdef0123456789abcdef")
            .bind("0123456789abcdef")
            .fetch_one(&mut *execute_spoof)
            .await
            .is_err()
    );
    execute_spoof.rollback().await.unwrap();

    let mut audit_spoof = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org_uuid.to_string())
        .execute(&mut *audit_spoof)
        .await
        .unwrap();
    assert!(
        sqlx::query(
            "INSERT INTO audit_events \
             (actor,action,target_type,target_id,branch_id,trace_id,span_id,occurred_at,org_id) \
             VALUES ($1,'employee.home_branch_set','employee',$2,$3,$4,$5,now(),$6)",
        )
        .bind(*actor.as_uuid())
        .bind(employee.to_string())
        .bind(branch)
        .bind("0123456789abcdef0123456789abcdef")
        .bind("0123456789abcdef")
        .bind(org_uuid)
        .execute(&mut *audit_spoof)
        .await
        .is_err(),
        "mnt_rt must not forge a protected leave audit after spoofing GUCs"
    );
    audit_spoof.rollback().await.unwrap();

    let store = PgLeaveStore::new(rt, Arc::new(PgInboxStore::new(owner_pool.clone())))
        .with_leave_command_pool(command_pool);
    let denied = mnt_platform_request_context::scope_org(org, async {
        store
            .set_employee_home_branch(
                employee,
                branch,
                expected,
                actor,
                mnt_kernel_core::TraceContext::generate(),
            )
            .await
    })
    .await;
    assert_eq!(denied.unwrap_err().kind(), ErrorKind::Forbidden);
    let denied_audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE target_id=$1 AND action='employee.home_branch_set'",
    )
    .bind(employee.to_string())
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(denied_audits, 0, "denied first assignment must not audit");

    let updated = mnt_platform_request_context::scope_org(org, async {
        store
            .set_employee_home_branch(
                employee,
                branch,
                expected,
                super_admin,
                mnt_kernel_core::TraceContext::generate(),
            )
            .await
    })
    .await
    .unwrap();
    assert_eq!(updated.home_branch_id, branch);
    let audit_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE target_id=$1 AND action='employee.home_branch_set'",
    )
    .bind(employee.to_string())
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(audit_count, 1);

    let stale = mnt_platform_request_context::scope_org(org, async {
        store
            .set_employee_home_branch(
                employee,
                branch,
                expected,
                super_admin,
                mnt_kernel_core::TraceContext::generate(),
            )
            .await
    })
    .await;
    assert!(matches!(
        stale,
        Err(mnt_leave_adapter_postgres::PgLeaveError::ConcurrentModification)
    ));
    let final_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE target_id=$1 AND action='employee.home_branch_set'",
    )
    .bind(employee.to_string())
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(final_count, 1, "failed command must not append audit");
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn imported_balance_command_preserves_expand_window_and_audits_once(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let command_pool = leave_command_role_pool(&owner_pool).await;
    let org = OrgId::knl();
    let org_uuid = *org.as_uuid();
    let branch_admin = seed_user(&owner_pool, org_uuid).await;
    let actor = UserId::new();
    sqlx::query(
        "INSERT INTO users (id,display_name,roles,org_id,is_active) \
         VALUES ($1,'Import owner',ARRAY['SUPER_ADMIN']::text[],$2,true)",
    )
    .bind(actor.as_uuid())
    .bind(org_uuid)
    .execute(&owner_pool)
    .await
    .unwrap();
    let employee = Uuid::new_v4();
    let source_key = format!("balance-import-{employee}");
    sqlx::query(
        "INSERT INTO employees (id,org_id,company,name,source_filename,source_sheet,source_row,source_key) \
         VALUES ($1,$2,'KNL','Imported employee','import.xlsx','Sheet1',1,$3)",
    )
    .bind(employee)
    .bind(org_uuid)
    .bind(&source_key)
    .execute(&owner_pool)
    .await
    .unwrap();
    let expected: OffsetDateTime =
        sqlx::query_scalar("SELECT updated_at FROM employees WHERE id=$1")
            .bind(employee)
            .fetch_one(&owner_pool)
            .await
            .unwrap();

    // The expand release intentionally retains f6ff's raw balance upsert until
    // it becomes the rollback floor. Do not encode the later command-only
    // contract early; instead prove the legacy path cannot acquire additive
    // home-branch authority.
    let forged = Uuid::new_v4();
    let mut direct = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org_uuid.to_string())
        .execute(&mut *direct)
        .await
        .unwrap();
    assert!(
        sqlx::query(
            "INSERT INTO employees (id,org_id,company,name,source_filename,source_sheet,source_row,source_key,leave_accrued,leave_used,leave_remaining,home_branch_id) \
             VALUES ($1,$2,'KNL','Forged','import.xlsx','Sheet1',2,$3,99,1,98,$4)",
        )
        .bind(forged)
        .bind(org_uuid)
        .bind(format!("forged-balance-{forged}"))
        .bind(Uuid::new_v4())
        .execute(&mut *direct)
        .await
        .is_err(),
        "legacy balance INSERT compatibility must not establish home-branch authority"
    );
    direct.rollback().await.unwrap();

    let mut direct = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org_uuid.to_string())
        .execute(&mut *direct)
        .await
        .unwrap();
    assert!(
        sqlx::query("UPDATE employees SET home_branch_id=$2 WHERE id=$1")
            .bind(employee)
            .bind(Uuid::new_v4())
            .execute(&mut *direct)
            .await
            .is_err(),
        "legacy balance UPDATE compatibility must not establish home-branch authority"
    );
    direct.rollback().await.unwrap();

    let key = format!("employee-import:test-run:{source_key}");
    let call = |accrued: &str, expected: OffsetDateTime| {
        sqlx::query(
            "SELECT * FROM leave_api.import_employee_leave_balance(\
             $1,$2,$3,$4,$5,$6,'employee_import',$7,$8,$9,$10,$11)",
        )
        .bind(org_uuid)
        .bind(employee)
        .bind(expected)
        .bind(accrued.to_owned())
        .bind("1.125000")
        .bind("10.875000")
        .bind("test-run")
        .bind(key.clone())
        .bind(*actor.as_uuid())
        .bind("0123456789abcdef0123456789abcdef")
        .bind("0123456789abcdef")
    };
    assert!(
        sqlx::query(
            "SELECT * FROM leave_api.import_employee_leave_balance(\
             $1,$2,$3,$4,$5,$6,'employee_import',$7,$8,$9,$10,$11)",
        )
        .bind(org_uuid)
        .bind(employee)
        .bind(expected)
        .bind("12.000001")
        .bind("1.125000")
        .bind("10.875000")
        .bind("test-run")
        .bind(format!("employee-import:branch-admin:{source_key}"))
        .bind(branch_admin.as_uuid())
        .bind("0123456789abcdef0123456789abcdef")
        .bind("0123456789abcdef")
        .fetch_one(&command_pool)
        .await
        .is_err(),
        "branch-scoped ADMIN must not execute an org-wide balance import"
    );
    let first = call("12.000001", expected)
        .fetch_one(&command_pool)
        .await
        .unwrap();
    assert!(first.get::<bool, _>("changed"));
    assert!(!first.get::<bool, _>("replayed"));
    let replay = call("12.000001", expected)
        .fetch_one(&command_pool)
        .await
        .unwrap();
    assert!(replay.get::<bool, _>("replayed"));
    assert!(
        call("13.000001", expected)
            .fetch_one(&command_pool)
            .await
            .is_err(),
        "an idempotency key cannot be rebound to a different payload"
    );
    let stored: (String, String, String) = sqlx::query_as(
        "SELECT leave_accrued::TEXT,leave_used::TEXT,leave_remaining::TEXT FROM employees WHERE id=$1",
    )
    .bind(employee)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(
        stored,
        ("12.000001".into(), "1.125000".into(), "10.875000".into())
    );
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id=$1 AND target_id=$2 \
         AND action='employee.leave_balance_import' AND actor=$3",
    )
    .bind(org_uuid)
    .bind(employee.to_string())
    .bind(actor.as_uuid())
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(
        audits, 1,
        "successful change audits once; replay/failure audit zero"
    );
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn approve_writes_ledger_and_enforces_sod_branch_and_tenant(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let command_pool = leave_command_role_pool(&owner_pool).await;
    let knl = OrgId::knl();
    let knl_uuid = *knl.as_uuid();
    let other = OrgId::from_uuid(OTHER_ORG);
    seed_org(&owner_pool, OTHER_ORG, "Other").await;

    let branch_a = seed_branch(&owner_pool, knl_uuid).await;
    let branch_b = seed_branch(&owner_pool, knl_uuid).await;
    let requester = seed_user(&owner_pool, knl_uuid).await;
    let approver = seed_user(&owner_pool, knl_uuid).await;
    let employee = seed_employee(&owner_pool, knl_uuid, 15.0, 0.0, 15.0).await;
    link_user_to_employee_and_branch(&owner_pool, knl_uuid, requester, employee, branch_a).await;
    link_user_to_branch(&owner_pool, knl_uuid, approver, branch_b).await;

    let store = test_store(&rt, &command_pool);

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

    link_user_to_branch(&owner_pool, knl_uuid, approver, branch_a).await;

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
                cursor: None,
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
                cursor: None,
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
                cursor: None,
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
    let balances = mnt_platform_request_context::scope_org(knl, async {
        store.list_balances(BranchScope::All).await
    })
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
async fn approve_rejects_when_days_exceed_remaining_balance(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let command_pool = leave_command_role_pool(&owner_pool).await;
    let knl = OrgId::knl();
    let knl_uuid = *knl.as_uuid();

    let branch = seed_branch(&owner_pool, knl_uuid).await;
    let requester = seed_user(&owner_pool, knl_uuid).await;
    let approver = seed_user(&owner_pool, knl_uuid).await;
    // Only 1 day remains; the request asks for 3 — an approval must not drive
    // the balance negative.
    let employee = seed_employee(&owner_pool, knl_uuid, 15.0, 14.0, 1.0).await;
    link_user_to_employee_and_branch(&owner_pool, knl_uuid, requester, employee, branch).await;
    link_user_to_branch(&owner_pool, knl_uuid, approver, branch).await;

    let store = test_store(&rt, &command_pool);

    let request = mnt_platform_request_context::scope_org(knl, async {
        store
            .create_request(create_cmd(branch, requester, employee, 3.0))
            .await
    })
    .await
    .expect("create request");

    let rejected = mnt_platform_request_context::scope_org(knl, async {
        store
            .decide(decide_cmd(
                request.id,
                approver,
                scope_of(branch),
                LeaveDecision::Approve,
            ))
            .await
    })
    .await;
    assert_eq!(
        rejected
            .expect_err("approval exceeding the remaining balance must fail")
            .kind(),
        ErrorKind::Validation,
        "an honest 422, not a negative balance"
    );

    // The whole transaction rolled back: no ledger write, no status flip.
    let (used, remaining): (f64, f64) = sqlx::query_as(
        "SELECT leave_used::float8, leave_remaining::float8 FROM employees WHERE id = $1",
    )
    .bind(employee)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert!((used - 14.0).abs() < f64::EPSILON, "ledger untouched");
    assert!((remaining - 1.0).abs() < f64::EPSILON, "ledger untouched");

    let still_pending = mnt_platform_request_context::scope_org(knl, async {
        store
            .list_requests(ListLeaveRequestsQuery {
                branch_scope: scope_of(branch),
                status: None,
                limit: 50,
                cursor: None,
            })
            .await
    })
    .await
    .unwrap();
    assert_eq!(still_pending.items[0].status, LeaveStatus::Pending);
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn leave_queue_keyset_pages_past_cap_without_concurrent_insert_drift(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let command_pool = leave_command_role_pool(&owner_pool).await;
    let org = OrgId::knl();
    let org_id = *org.as_uuid();
    let branch = seed_branch(&owner_pool, org_id).await;
    let requester = seed_user(&owner_pool, org_id).await;
    let employee = seed_employee(&owner_pool, org_id, 366.0, 0.0, 366.0).await;
    link_user_to_employee_and_branch(&owner_pool, org_id, requester, employee, branch).await;

    let base = OffsetDateTime::now_utc() - time::Duration::days(1);
    let mut seed_requests = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE mnt_leave_definer")
        .execute(&mut *seed_requests)
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org_id.to_string())
        .execute(&mut *seed_requests)
        .await
        .unwrap();
    let seeded_ids: Vec<Uuid> = sqlx::query_scalar(
        "INSERT INTO leave_requests (\
             org_id, branch_id, requester_user_id, subject_employee_id, leave_type, days, \
             start_date, end_date, reason, created_at\
         ) \
         SELECT $1, $2, $3, $4, 'annual', 1, DATE '2026-07-06', DATE '2026-07-06', \
                'pagination fixture', $5 + make_interval(secs => series_no) \
         FROM generate_series(1, 205) AS series_no \
         RETURNING id",
    )
    .bind(org_id)
    .bind(branch)
    .bind(*requester.as_uuid())
    .bind(employee)
    .bind(base)
    .fetch_all(&mut *seed_requests)
    .await
    .unwrap();
    seed_requests.commit().await.unwrap();

    let store = test_store(&rt, &command_pool);
    let query = |cursor| ListLeaveRequestsQuery {
        branch_scope: scope_of(branch),
        status: None,
        limit: 200,
        cursor,
    };

    let first = mnt_platform_request_context::scope_org(org, async {
        store.list_requests(query(None)).await
    })
    .await
    .unwrap();
    assert_eq!(first.items.len(), 200);
    let cursor = first.next_cursor.expect("five rows remain after the cap");
    let self_first = mnt_platform_request_context::scope_org(org, async {
        store
            .list_self_requests(ListSelfLeaveRequestsQuery {
                requester,
                limit: 200,
                cursor: None,
            })
            .await
    })
    .await
    .unwrap();
    assert_eq!(self_first.items.len(), 200);
    let self_cursor = self_first
        .next_cursor
        .expect("five self-service rows remain after the cap");

    // A row inserted after page one sorts ahead of its cursor. A stable keyset
    // must not duplicate, skip, or splice that concurrent row into page two.
    let mut insert_concurrent = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE mnt_leave_definer")
        .execute(&mut *insert_concurrent)
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org_id.to_string())
        .execute(&mut *insert_concurrent)
        .await
        .unwrap();
    let concurrent_id: Uuid = sqlx::query_scalar(
        "INSERT INTO leave_requests (\
             org_id, branch_id, requester_user_id, subject_employee_id, leave_type, days, \
             start_date, end_date, reason, created_at\
         ) VALUES ($1, $2, $3, $4, 'annual', 1, DATE '2026-07-07', DATE '2026-07-07', \
                   'concurrent pagination fixture', $5) \
         RETURNING id",
    )
    .bind(org_id)
    .bind(branch)
    .bind(*requester.as_uuid())
    .bind(employee)
    .bind(OffsetDateTime::now_utc())
    .fetch_one(&mut *insert_concurrent)
    .await
    .unwrap();
    insert_concurrent.commit().await.unwrap();

    let second = mnt_platform_request_context::scope_org(org, async {
        store.list_requests(query(Some(cursor))).await
    })
    .await
    .unwrap();
    assert_eq!(second.items.len(), 5);
    assert!(second.next_cursor.is_none());
    let self_second = mnt_platform_request_context::scope_org(org, async {
        store
            .list_self_requests(ListSelfLeaveRequestsQuery {
                requester,
                limit: 200,
                cursor: Some(self_cursor),
            })
            .await
    })
    .await
    .unwrap();
    assert_eq!(self_second.items.len(), 5);
    assert!(self_second.next_cursor.is_none());

    let paged_ids = first
        .items
        .iter()
        .chain(&second.items)
        .map(|request| *request.id.as_uuid())
        .collect::<BTreeSet<_>>();
    assert_eq!(paged_ids.len(), 205, "pages must neither overlap nor skip");
    assert_eq!(
        paged_ids,
        seeded_ids.into_iter().collect(),
        "paging returns exactly the original snapshot tail"
    );
    assert!(!paged_ids.contains(&concurrent_id));
    let self_paged_ids = self_first
        .items
        .iter()
        .chain(&self_second.items)
        .map(|request| *request.id.as_uuid())
        .collect::<BTreeSet<_>>();
    assert_eq!(self_paged_ids, paged_ids);
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn self_service_create_resolves_subject_and_branch_from_caller(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let command_pool = leave_command_role_pool(&owner_pool).await;
    let knl = OrgId::knl();
    let knl_uuid = *knl.as_uuid();

    let branch = seed_branch(&owner_pool, knl_uuid).await;
    let changed_branch = seed_branch(&owner_pool, knl_uuid).await;
    let filer = seed_user(&owner_pool, knl_uuid).await;
    let employee = seed_employee(&owner_pool, knl_uuid, 15.0, 0.0, 15.0).await;
    link_user_to_employee_and_branch(&owner_pool, knl_uuid, filer, employee, branch).await;

    let calendar_revision = Arc::new(AtomicUsize::new(1));
    let store = PgLeaveStore::with_work_calendar(
        rt.clone(),
        Arc::new(PgInboxStore::new(rt.clone())),
        Arc::new(MutableCalendar {
            revision: calendar_revision.clone(),
        }),
    )
    .with_leave_command_pool(command_pool.clone());

    // The caller's OWN filing context is resolved from their account — not input.
    let (subject, resolved_branch) = mnt_platform_request_context::scope_org(knl, async {
        store.resolve_self_filing_context(filer).await
    })
    .await
    .expect("linked filer resolves a subject + branch");
    assert_eq!(subject, employee, "subject is the caller's own employee");
    assert_eq!(resolved_branch, branch);

    // Filing with that resolved context creates a pending, requester=self row.
    let create = create_cmd(resolved_branch, filer, subject, 3.0);
    let request = mnt_platform_request_context::scope_org(knl, async {
        store.create_request(create.clone()).await
    })
    .await
    .expect("self-service create");
    assert_eq!(request.status, LeaveStatus::Pending);
    assert_eq!(request.requester_user_id, filer);
    assert_eq!(request.subject_employee_id, employee);
    assert_eq!(request.branch_id, branch);
    assert_eq!(request.charge_state, LeaveChargeState::Resolved);
    assert_eq!(request.request_version, 1);
    assert_eq!(request.charge_version, 1);

    // Simulate an HTTP response lost after the database committed. Before the
    // retry, both server-derived contexts change: HR re-routes the employee and
    // the calendar/policy adapter advances its evidence revision. Idempotency
    // remains bound to the client's canonical intent, not mutable server state.
    calendar_revision.store(2, Ordering::SeqCst);
    let mut reroute = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE mnt_leave_definer")
        .execute(&mut *reroute)
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(knl_uuid.to_string())
        .execute(&mut *reroute)
        .await
        .unwrap();
    sqlx::query("UPDATE employees SET home_branch_id=$1 WHERE id=$2")
        .bind(changed_branch)
        .bind(employee)
        .execute(&mut *reroute)
        .await
        .unwrap();
    reroute.commit().await.unwrap();
    let replay = mnt_platform_request_context::scope_org(knl, async {
        store.create_request(create.clone()).await
    })
    .await
    .expect("lost-response retry replays the committed request");
    assert_eq!(
        replay, request,
        "replay returns the original committed view"
    );

    let (pointer_present, resolution_count, create_audits): (bool, i64, i64) = sqlx::query_as(
        "SELECT lr.current_charge_resolution_id IS NOT NULL, \
                (SELECT count(*) FROM leave_charge_resolutions r WHERE r.request_id=lr.id), \
                (SELECT count(*) FROM audit_events a \
                  WHERE a.target_id=lr.id::text AND a.action='leave_request.create') \
         FROM leave_requests lr WHERE lr.id=$1",
    )
    .bind(request.id.as_uuid())
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert!(
        pointer_present,
        "resolved create must finish with an evidence pointer"
    );
    assert_eq!(
        resolution_count, 1,
        "resolved create persists one immutable resolution"
    );
    assert_eq!(
        create_audits, 1,
        "resolved create appends exactly one audit event"
    );

    let mut conflicting = create;
    conflicting.request = NewLeaveRequest::new(
        LeaveType::Annual,
        date(2026, 7, 6),
        date(2026, 7, 8),
        "different intent under reused submission key",
        None,
    )
    .unwrap();
    let conflict = mnt_platform_request_context::scope_org(knl, async {
        store.create_request(conflicting).await
    })
    .await
    .expect_err("same submission key with different intent must conflict");
    assert_eq!(conflict.kind(), ErrorKind::Conflict);

    // An account with NO linked employee cannot file (deny-by-omission → 422).
    let unlinked = seed_user(&owner_pool, knl_uuid).await;
    let denied = mnt_platform_request_context::scope_org(knl, async {
        store.resolve_self_filing_context(unlinked).await
    })
    .await
    .expect_err("an unlinked account cannot self-file leave");
    assert_eq!(denied.kind(), ErrorKind::Forbidden);

    // An account linked to an employee but to no branch also fails closed.
    let branchless = seed_user(&owner_pool, knl_uuid).await;
    let branchless_employee = seed_employee(&owner_pool, knl_uuid, 15.0, 0.0, 15.0).await;
    sqlx::query("UPDATE users SET employee_id = $2 WHERE id = $1 AND org_id = $3")
        .bind(branchless.as_uuid())
        .bind(branchless_employee)
        .bind(knl_uuid)
        .execute(&owner_pool)
        .await
        .unwrap();
    let denied = mnt_platform_request_context::scope_org(knl, async {
        store.resolve_self_filing_context(branchless).await
    })
    .await
    .expect_err("an employee-linked account without a branch cannot self-file leave");
    assert_eq!(denied.kind(), ErrorKind::Conflict);
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn statutory_push_delivers_receipt_doc_and_is_idempotent(owner_pool: PgPool) {
    let rt = runtime_role_pool(&owner_pool).await;
    let command_pool = leave_command_role_pool(&owner_pool).await;
    let knl = OrgId::knl();
    let knl_uuid = *knl.as_uuid();
    let branch = seed_branch(&owner_pool, knl_uuid).await;
    let actor = seed_user(&owner_pool, knl_uuid).await;
    let target = seed_user(&owner_pool, knl_uuid).await;
    let target_emp = seed_employee(&owner_pool, knl_uuid, 15.0, 2.0, 13.0).await;
    let other_emp = seed_employee(&owner_pool, knl_uuid, 10.0, 1.0, 9.0).await;
    link_user_to_employee_and_branch(&owner_pool, knl_uuid, target, target_emp, branch).await;

    let store = test_store(&rt, &command_pool);

    mnt_platform_request_context::scope_org(knl, async {
        store
            .verify_statutory_push_target(branch, target, target_emp)
            .await
    })
    .await
    .expect("linked target is valid for statutory push");

    let mismatch = mnt_platform_request_context::scope_org(knl, async {
        store
            .verify_statutory_push_target(branch, target, other_emp)
            .await
    })
    .await
    .expect_err("target user must match target employee");
    assert_eq!(mismatch.kind(), ErrorKind::Forbidden);

    let wrong_branch = seed_branch(&owner_pool, knl_uuid).await;
    let wrong_branch_result = mnt_platform_request_context::scope_org(knl, async {
        store
            .verify_statutory_push_target(wrong_branch, target, target_emp)
            .await
    })
    .await
    .expect_err("target must belong to authorized branch");
    assert_eq!(wrong_branch_result.kind(), ErrorKind::Forbidden);

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
    assert_eq!(r1.ap_submission, ApSubmission::PendingEngineDefinition);

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
