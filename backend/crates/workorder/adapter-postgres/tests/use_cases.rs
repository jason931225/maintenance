#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use mnt_kernel_core::{BranchId, ErrorKind, OrgId, TraceContext, UserId, WorkOrderId};
use mnt_workorder_adapter_postgres::PgWorkOrderStore;
use mnt_workorder_application::{
    AssignmentInput, CreateDailyPlanCommand, CreateOutsourceWorkCommand, CreateWorkOrderCommand,
    DailyPlanItemInput, DailyPlanStatus, ReviewDailyPlanCommand, ReviewTargetChangeCommand,
    SendDailyPlanForReviewCommand, SubmitReportCommand, TargetChangeDecision,
    TargetChangeRequestCommand, UpdatePriorityCommand, UpdateWorkOrderIntakeCommand,
    WorkOrderApprovalCommand, WorkOrderAssignmentCommand, WorkOrderCreatedEvent,
    WorkOrderCreatedFuture, WorkOrderCreatedListener, WorkOrderStartCommand,
};
use mnt_workorder_domain::{
    AssignmentRole, AttachmentStage, PriorityLevel, WorkOrderStatus, WorkResultType,
};
use sqlx::{PgPool, Row};
use time::{Duration, OffsetDateTime, macros::date};

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn lifecycle_mutations_persist_state_and_audit_in_order(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
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
        // The intake submitter cannot set 중요도: CreateWorkOrderCommand carries no
        // priority field, so a freshly created work order is server-assigned UNSET
        // and waits for an admin to classify it via update_priority (asserted below).
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
                comment: "검토 의견".to_owned(),
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
                comment: "검토 의견".to_owned(),
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

        insert_evidence_media(
            &pool,
            created.id,
            seeded.mechanic,
            AttachmentStage::Report,
            "VERIFIED",
        )
        .await;

        let completed = store
            .approve_work_order(WorkOrderApprovalCommand {
                actor: seeded.executive,
                work_order_id: created.id,
                comment: "검토 의견".to_owned(),
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
    })
    .await;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn update_intake_edits_work_order_narrative_and_audits(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let seeded = seed_operational_context(&pool).await;
        let store = PgWorkOrderStore::new(pool.clone());
        let created = store
            .create_work_order(CreateWorkOrderCommand {
                actor: seeded.receptionist,
                branch_id: seeded.branch_id,
                management_no: "#290".to_owned(),
                symptom: "Hydraulic oil leak".to_owned(),
                customer_request: Some("Inspect before afternoon shift".to_owned()),
                target_due_at: None,
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            })
            .await
            .unwrap();

        let updated = store
            .update_work_order_intake(UpdateWorkOrderIntakeCommand {
                actor: seeded.admin,
                work_order_id: created.id,
                symptom: Some("Hydraulic oil leak with pump noise".to_owned()),
                // Empty string is an intentional clear of the optional field.
                customer_request: Some("".to_owned()),
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            })
            .await
            .unwrap();

        assert_eq!(updated.id, created.id);
        let row = sqlx::query("SELECT symptom, customer_request FROM work_orders WHERE id = $1")
            .bind(*created.id.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
        let symptom: String = row.try_get("symptom").unwrap();
        let customer_request: Option<String> = row.try_get("customer_request").unwrap();
        assert_eq!(symptom, "Hydraulic oil leak with pump noise");
        assert_eq!(customer_request, None);

        let actions = audit_actions_for(&pool, created.id).await;
        assert_eq!(
            actions,
            vec!["work_order.create", "work_order.update_intake"]
        );
    })
    .await;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn final_completion_ignores_legacy_flag_and_blocks_unverified_completion_evidence(
    pool: PgPool,
) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let seeded = seed_operational_context(&pool).await;
        let store = PgWorkOrderStore::new(pool.clone());
        let created = create_reported_work_order(&store, &seeded).await;

        let admin_review = store
            .approve_work_order(WorkOrderApprovalCommand {
                actor: seeded.admin,
                work_order_id: created.id,
                comment: "검토 의견".to_owned(),
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            })
            .await
            .unwrap();
        assert_eq!(admin_review.status, WorkOrderStatus::AdminReview);

        sqlx::query("UPDATE work_orders SET evidence_verified = true WHERE id = $1")
            .bind(*created.id.as_uuid())
            .execute(&pool)
            .await
            .unwrap();
        insert_evidence_media(
            &pool,
            created.id,
            seeded.mechanic,
            AttachmentStage::After,
            "PENDING",
        )
        .await;

        let blocked = store
            .approve_work_order(WorkOrderApprovalCommand {
                actor: seeded.executive,
                work_order_id: created.id,
                comment: "검토 의견".to_owned(),
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
    })
    .await;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn request_numbers_are_race_safe_and_sequential_per_day(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
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
    })
    .await;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn create_work_order_emits_post_commit_created_event(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let seeded = seed_operational_context(&pool).await;
        let listener = Arc::new(RecordingCreatedListener::new(pool.clone()));
        let store = PgWorkOrderStore::new(pool.clone()).with_created_listener(listener.clone());

        let created = store
            .create_work_order(CreateWorkOrderCommand {
                actor: seeded.receptionist,
                branch_id: seeded.branch_id,
                management_no: "290".to_owned(),
                symptom: "Create messenger thread".to_owned(),
                customer_request: None,
                target_due_at: None,
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            })
            .await
            .unwrap();

        let events = listener.events.lock().unwrap().clone();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].work_order_id, created.id);
        assert_eq!(events[0].branch_id, seeded.branch_id);
        assert_eq!(events[0].actor, seeded.receptionist);
    })
    .await;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn target_change_daily_plan_and_outsource_flows_are_audited(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
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
                    work_order_id: work_order.id,
                    description: "Repair hydraulic leak".to_owned(),
                }],
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            })
            .await
            .unwrap();
        assert_eq!(daily_plan.status, DailyPlanStatus::Draft);
        assert_eq!(daily_plan.items.len(), 1);
        assert_eq!(daily_plan.items[0].work_order_id, Some(work_order.id));
        assert_eq!(
            daily_plan.items[0].request_no.as_deref(),
            Some(work_order.request_no.as_str())
        );

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
        assert_eq!(
            requested.items[0].request_no.as_deref(),
            Some(work_order.request_no.as_str())
        );

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
    })
    .await;
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

async fn create_reported_work_order(
    store: &PgWorkOrderStore,
    seeded: &SeededContext,
) -> mnt_workorder_application::WorkOrderSummary {
    let assigned = create_assigned_work_order(store, seeded).await;
    store
        .start_work(WorkOrderStartCommand {
            actor: seeded.mechanic,
            work_order_id: assigned.id,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .unwrap();
    store
        .submit_report(SubmitReportCommand {
            actor: seeded.mechanic,
            work_order_id: assigned.id,
            result_type: WorkResultType::Completed,
            diagnosis: "Pump cavitation under load".to_owned(),
            action_taken: "Replaced inlet seal and pressure-tested".to_owned(),
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .unwrap()
}

async fn insert_evidence_media(
    pool: &PgPool,
    work_order_id: WorkOrderId,
    uploaded_by: UserId,
    stage: AttachmentStage,
    status: &str,
) {
    sqlx::query(
        r#"
        INSERT INTO evidence_media (
            work_order_id, stage, s3_key, content_type, size_bytes,
            uploaded_by, worm_replica_status, retry_count, org_id
        )
        VALUES ($1, $2, $3, 'image/jpeg', 1024, $4, $5, 0, $6)
        "#,
    )
    .bind(*work_order_id.as_uuid())
    .bind(stage.as_db_str())
    .bind(format!(
        "work-orders/{}/{}/{}.jpg",
        work_order_id,
        stage.as_db_str(),
        uuid::Uuid::new_v4()
    ))
    .bind(*uploaded_by.as_uuid())
    .bind(status)
    .bind(*OrgId::knl().as_uuid())
    .execute(pool)
    .await
    .unwrap();
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
    let knl = *OrgId::knl().as_uuid();
    let region_id: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(format!("Region {}", uuid::Uuid::new_v4()))
            .bind(knl)
            .fetch_one(pool)
            .await
            .unwrap();
    let branch_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(region_id)
    .bind("HQ Test")
    .bind(knl)
    .fetch_one(pool)
    .await
    .unwrap();
    BranchId::from_uuid(branch_id)
}

async fn seed_user(pool: &PgPool, name: &str, role: &str, branch_id: BranchId) -> UserId {
    let knl = *OrgId::knl().as_uuid();
    let user_id = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*user_id.as_uuid())
        .bind(name)
        .bind(Vec::from([role]))
        .bind(knl)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(*user_id.as_uuid())
        .bind(*branch_id.as_uuid())
        .bind(knl)
        .execute(pool)
        .await
        .unwrap();
    user_id
}

#[derive(Debug)]
struct RecordingCreatedListener {
    pool: PgPool,
    events: Arc<Mutex<Vec<WorkOrderCreatedEvent>>>,
}

impl RecordingCreatedListener {
    fn new(pool: PgPool) -> Self {
        Self {
            pool,
            events: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl WorkOrderCreatedListener for RecordingCreatedListener {
    fn work_order_created(&self, event: WorkOrderCreatedEvent) -> WorkOrderCreatedFuture<'_> {
        Box::pin(async move {
            let row = sqlx::query(
                r#"
                SELECT EXISTS(
                    SELECT 1 FROM work_orders WHERE id = $1
                ) AS work_order_exists,
                EXISTS(
                    SELECT 1 FROM audit_events
                    WHERE action = 'work_order.create'
                      AND target_id = $2
                ) AS audit_exists
                "#,
            )
            .bind(*event.work_order_id.as_uuid())
            .bind(event.work_order_id.to_string())
            .fetch_one(&self.pool)
            .await
            .unwrap();
            assert!(row.get::<Option<bool>, _>("work_order_exists").unwrap());
            assert!(row.get::<Option<bool>, _>("audit_exists").unwrap());
            self.events.lock().unwrap().push(event);
            Ok(())
        })
    }
}

async fn seed_equipment(pool: &PgPool, branch_id: BranchId) -> uuid::Uuid {
    let knl = *OrgId::knl().as_uuid();
    let customer_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO registry_customers (branch_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(*branch_id.as_uuid())
    .bind("Customer A")
    .bind(knl)
    .fetch_one(pool)
    .await
    .unwrap();
    let site_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO registry_sites (branch_id, customer_id, name, org_id) VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(*branch_id.as_uuid())
    .bind(customer_id)
    .bind("Site A")
    .bind(knl)
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query_scalar(
        r#"
        INSERT INTO registry_equipment (
            branch_id, customer_id, site_id, equipment_no, management_no,
            manufacturer_code, kind_code, power_code, status,
            specification, ton_text, model, source_sheet, source_row, org_id
        )
        VALUES ($1, $2, $3, 'ABC12-0290', '290',
                'A', 'B', 'C', '임대', '좌식', '2.5', 'GTS25DE', 'test', 1, $4)
        RETURNING id
        "#,
    )
    .bind(*branch_id.as_uuid())
    .bind(customer_id)
    .bind(site_id)
    .bind(knl)
    .fetch_one(pool)
    .await
    .unwrap()
}
