#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use mnt_kernel_core::{BranchId, ErrorKind, TraceContext, UserId, WorkOrderId};
use mnt_workorder_adapter_postgres::PgWorkOrderStore;
use mnt_workorder_application::{
    AssignmentInput, CreateDailyPlanCommand, CreateOutsourceWorkCommand, CreateWorkOrderCommand,
    DailyPlanItemInput, DailyPlanStatus, ReviewDailyPlanCommand, ReviewTargetChangeCommand,
    SendDailyPlanForReviewCommand, SubmitReportCommand, TargetChangeDecision,
    TargetChangeRequestCommand, UpdatePriorityCommand, WorkOrderApprovalCommand,
    WorkOrderAssignmentCommand, WorkOrderStartCommand,
};
use mnt_workorder_domain::{AssignmentRole, PriorityLevel, WorkOrderStatus, WorkResultType};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime, macros::date};

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn lifecycle_mutations_persist_state_and_audit_in_order(pool: PgPool) {
    let seeded = seed_operational_context(&pool).await;
    let store = PgWorkOrderStore::new(pool.clone());
    let created = store
        .create_work_order(CreateWorkOrderCommand {
            actor: seeded.receptionist,
            branch_id: seeded.branch_id,
            management_no: "#290".to_owned(),
            symptom: "Hydraulic oil leak".to_owned(),
            customer_request: Some("Inspect before afternoon shift".to_owned()),
            target_due_at: Some(OffsetDateTime::now_utc() + Duration::days(1)),
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .unwrap();

    assert_eq!(created.branch_id, seeded.branch_id);
    assert_eq!(created.status, WorkOrderStatus::Received);
    assert_eq!(created.priority, PriorityLevel::Unset);
    assert_eq!(*created.equipment_id.as_uuid(), seeded.equipment_id);
    assert!(created.request_no.ends_with("-001"));

    let prioritized = store
        .update_priority(UpdatePriorityCommand {
            actor: seeded.admin,
            work_order_id: created.id,
            priority: PriorityLevel::P2,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .unwrap();
    assert_eq!(prioritized.priority, PriorityLevel::P2);

    let assigned = store
        .assign_work_order(WorkOrderAssignmentCommand {
            actor: seeded.admin,
            work_order_id: created.id,
            assignments: vec![
                AssignmentInput {
                    mechanic_id: seeded.mechanic,
                    role: AssignmentRole::Primary,
                },
                AssignmentInput {
                    mechanic_id: seeded.helper,
                    role: AssignmentRole::Secondary,
                },
            ],
            admin_approver_id: Some(seeded.admin),
            executive_approver_id: Some(seeded.executive),
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .unwrap();
    assert_eq!(assigned.status, WorkOrderStatus::Assigned);

    let started = store
        .start_work(WorkOrderStartCommand {
            actor: seeded.mechanic,
            work_order_id: created.id,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .unwrap();
    assert_eq!(started.status, WorkOrderStatus::InProgress);

    let reported = store
        .submit_report(SubmitReportCommand {
            actor: seeded.mechanic,
            work_order_id: created.id,
            result_type: WorkResultType::Completed,
            diagnosis: "Hose fitting loosened under load".to_owned(),
            action_taken: "Retightened fitting and pressure-tested".to_owned(),
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .unwrap();
    assert_eq!(reported.status, WorkOrderStatus::ReportSubmitted);

    let admin_review = store
        .approve_work_order(WorkOrderApprovalCommand {
            actor: seeded.admin,
            work_order_id: created.id,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .unwrap();
    assert_eq!(admin_review.status, WorkOrderStatus::AdminReview);

    let blocked = store
        .approve_work_order(WorkOrderApprovalCommand {
            actor: seeded.executive,
            work_order_id: created.id,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .unwrap_err();
    assert_eq!(blocked.kind(), ErrorKind::Conflict);
    assert_eq!(
        store.work_order(created.id).await.unwrap().status,
        WorkOrderStatus::AdminReview
    );

    sqlx::query("UPDATE work_orders SET evidence_verified = true WHERE id = $1")
        .bind(*created.id.as_uuid())
        .execute(&pool)
        .await
        .unwrap();

    let completed = store
        .approve_work_order(WorkOrderApprovalCommand {
            actor: seeded.executive,
            work_order_id: created.id,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .unwrap();
    assert_eq!(completed.status, WorkOrderStatus::FinalCompleted);

    let actions = audit_actions_for(&pool, created.id).await;
    assert_eq!(
        actions,
        vec![
            "work_order.create",
            "work_order.priority",
            "work_order.assign",
            "work_order.start",
            "work_order.report",
            "work_order.approve",
            "work_order.approve",
        ]
    );
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn request_numbers_are_race_safe_and_sequential_per_day(pool: PgPool) {
    let seeded = seed_operational_context(&pool).await;
    let store = PgWorkOrderStore::new(pool.clone());
    let now = OffsetDateTime::now_utc();

    let first = store.create_work_order(CreateWorkOrderCommand {
        actor: seeded.receptionist,
        branch_id: seeded.branch_id,
        management_no: "290".to_owned(),
        symptom: "First concurrent intake".to_owned(),
        customer_request: None,
        target_due_at: None,
        trace: TraceContext::generate(),
        occurred_at: now,
    });
    let second = store.create_work_order(CreateWorkOrderCommand {
        actor: seeded.receptionist,
        branch_id: seeded.branch_id,
        management_no: "290".to_owned(),
        symptom: "Second concurrent intake".to_owned(),
        customer_request: None,
        target_due_at: None,
        trace: TraceContext::generate(),
        occurred_at: now,
    });

    let (first, second) = tokio::join!(first, second);
    let mut request_numbers = vec![first.unwrap().request_no, second.unwrap().request_no];
    request_numbers.sort();

    let ymd = now.date();
    let prefix = format!(
        "{:04}{:02}{:02}",
        ymd.year(),
        u8::from(ymd.month()),
        ymd.day()
    );
    assert_eq!(
        request_numbers,
        vec![format!("{prefix}-001"), format!("{prefix}-002")]
    );
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn target_change_daily_plan_and_outsource_flows_are_audited(pool: PgPool) {
    let seeded = seed_operational_context(&pool).await;
    let store = PgWorkOrderStore::new(pool.clone());
    let work_order = create_assigned_work_order(&store, &seeded).await;

    let target_request = store
        .request_target_change(TargetChangeRequestCommand {
            actor: seeded.mechanic,
            work_order_id: work_order.id,
            requested_target_due_at: OffsetDateTime::now_utc() + Duration::days(3),
            reason: "Customer kept equipment in production".to_owned(),
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .unwrap();
    let reviewed = store
        .review_target_change(ReviewTargetChangeCommand {
            actor: seeded.admin,
            request_id: target_request.id,
            decision: TargetChangeDecision::Approved,
            memo: Some("Customer schedule confirmed".to_owned()),
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .unwrap();
    assert_eq!(reviewed.status, TargetChangeDecision::Approved.into());

    let daily_plan = store
        .create_daily_plan(CreateDailyPlanCommand {
            actor: seeded.mechanic,
            branch_id: seeded.branch_id,
            mechanic_id: seeded.mechanic,
            plan_date: date!(2026 - 06 - 12),
            items: vec![DailyPlanItemInput {
                work_order_id: Some(work_order.id),
                description: "Repair hydraulic leak".to_owned(),
            }],
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .unwrap();
    assert_eq!(daily_plan.status, DailyPlanStatus::Draft);

    let requested = store
        .request_daily_plan_review(SendDailyPlanForReviewCommand {
            actor: seeded.mechanic,
            plan_id: daily_plan.id,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .unwrap();
    assert_eq!(requested.status, DailyPlanStatus::Requested);

    let approved = store
        .review_daily_plan(ReviewDailyPlanCommand {
            actor: seeded.admin,
            plan_id: daily_plan.id,
            decision: DailyPlanStatus::Approved,
            memo: Some("Plan accepted".to_owned()),
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .unwrap();
    assert_eq!(approved.status, DailyPlanStatus::Approved);

    let confirmed = store
        .confirm_daily_plan(SendDailyPlanForReviewCommand {
            actor: seeded.mechanic,
            plan_id: daily_plan.id,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .unwrap();
    assert_eq!(confirmed.status, DailyPlanStatus::FinalConfirmed);

    let outsource = store
        .create_outsource_work(CreateOutsourceWorkCommand {
            actor: seeded.admin,
            work_order_id: work_order.id,
            vendor_name: "Reliable Forklift Service".to_owned(),
            vendor_contact: Some("ops@example.invalid".to_owned()),
            reason: "Requires vendor diagnostic tool".to_owned(),
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .unwrap();
    assert_eq!(outsource.vendor_name, "Reliable Forklift Service");

    let actions = audit_actions_for(&pool, work_order.id).await;
    assert!(actions.contains(&"target_change.request".to_owned()));
    assert!(actions.contains(&"target_change.review".to_owned()));
    assert!(actions.contains(&"work_order.outsource".to_owned()));

    let plan_audits: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE target_type = 'daily_work_plan'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(plan_audits, 4);
}

struct SeededContext {
    branch_id: BranchId,
    receptionist: UserId,
    mechanic: UserId,
    helper: UserId,
    admin: UserId,
    executive: UserId,
    equipment_id: uuid::Uuid,
}

async fn create_assigned_work_order(
    store: &PgWorkOrderStore,
    seeded: &SeededContext,
) -> mnt_workorder_application::WorkOrderSummary {
    let created = store
        .create_work_order(CreateWorkOrderCommand {
            actor: seeded.receptionist,
            branch_id: seeded.branch_id,
            management_no: "290".to_owned(),
            symptom: "Assigned WO fixture".to_owned(),
            customer_request: None,
            target_due_at: None,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .unwrap();

    store
        .assign_work_order(WorkOrderAssignmentCommand {
            actor: seeded.admin,
            work_order_id: created.id,
            assignments: vec![AssignmentInput {
                mechanic_id: seeded.mechanic,
                role: AssignmentRole::Primary,
            }],
            admin_approver_id: Some(seeded.admin),
            executive_approver_id: Some(seeded.executive),
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .unwrap()
}

async fn audit_actions_for(pool: &PgPool, work_order_id: WorkOrderId) -> Vec<String> {
    sqlx::query_scalar(
        r#"
        SELECT action
        FROM audit_events
        WHERE target_id = $1
        ORDER BY occurred_at, created_at
        "#,
    )
    .bind(work_order_id.to_string())
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn seed_operational_context(pool: &PgPool) -> SeededContext {
    let branch_id = seed_branch(pool).await;
    let receptionist = seed_user(pool, "Receptionist", "RECEPTIONIST", branch_id).await;
    let mechanic = seed_user(pool, "Mechanic", "MECHANIC", branch_id).await;
    let helper = seed_user(pool, "Helper", "MECHANIC", branch_id).await;
    let admin = seed_user(pool, "Admin", "ADMIN", branch_id).await;
    let executive = seed_user(pool, "Executive", "EXECUTIVE", branch_id).await;
    let equipment_id = seed_equipment(pool, branch_id).await;

    SeededContext {
        branch_id,
        receptionist,
        mechanic,
        helper,
        admin,
        executive,
        equipment_id,
    }
}

async fn seed_branch(pool: &PgPool) -> BranchId {
    let region_id: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO regions (name) VALUES ($1) RETURNING id")
            .bind(format!("Region {}", uuid::Uuid::new_v4()))
            .fetch_one(pool)
            .await
            .unwrap();
    let branch_id: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO branches (region_id, name) VALUES ($1, $2) RETURNING id")
            .bind(region_id)
            .bind("HQ Test")
            .fetch_one(pool)
            .await
            .unwrap();
    BranchId::from_uuid(branch_id)
}

async fn seed_user(pool: &PgPool, name: &str, role: &str, branch_id: BranchId) -> UserId {
    let user_id = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles) VALUES ($1, $2, $3)")
        .bind(*user_id.as_uuid())
        .bind(name)
        .bind(Vec::from([role]))
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO user_branches (user_id, branch_id) VALUES ($1, $2)")
        .bind(*user_id.as_uuid())
        .bind(*branch_id.as_uuid())
        .execute(pool)
        .await
        .unwrap();
    user_id
}

async fn seed_equipment(pool: &PgPool, branch_id: BranchId) -> uuid::Uuid {
    let customer_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO registry_customers (branch_id, name) VALUES ($1, $2) RETURNING id",
    )
    .bind(*branch_id.as_uuid())
    .bind("Customer A")
    .fetch_one(pool)
    .await
    .unwrap();
    let site_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO registry_sites (branch_id, customer_id, name) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(*branch_id.as_uuid())
    .bind(customer_id)
    .bind("Site A")
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query_scalar(
        r#"
        INSERT INTO registry_equipment (
            branch_id, customer_id, site_id, equipment_no, management_no,
            manufacturer_code, kind_code, power_code, status,
            specification, ton_text, model, source_sheet, source_row
        )
        VALUES ($1, $2, $3, 'ABC12-0290', '290',
                'A', 'B', 'C', '임대', '좌식', '2.5', 'GTS25DE', 'test', 1)
        RETURNING id
        "#,
    )
    .bind(*branch_id.as_uuid())
    .bind(customer_id)
    .bind(site_id)
    .fetch_one(pool)
    .await
    .unwrap()
}
