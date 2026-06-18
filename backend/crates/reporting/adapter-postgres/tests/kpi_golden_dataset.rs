#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use mnt_kernel_core::{BranchId, BranchScope, OrgId, RegionId, UserId};
use mnt_reporting_adapter_postgres::PgKpiRepository;
use mnt_reporting_application::{KpiQuery, KpiQueryPort, KpiScope, Period};
use mnt_reporting_domain::{KpiMetric, KpiRollupScope};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime, macros::datetime};

const PERIOD_START: OffsetDateTime = datetime!(2026-06-01 00:00 UTC);
const PERIOD_END: OffsetDateTime = datetime!(2026-07-01 00:00 UTC);

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn completed_count_uses_approval_period_priority_weights_and_exclusions(pool: PgPool) {
    let seeded = seed_golden_dataset(&pool).await;
    let report = company_report(&pool).await;
    let company = report.rollup(&KpiRollupScope::Company).unwrap();

    assert_eq!(company.completed_count, 3);
    assert_eq!(company.weighted_completed_points, 6);
    assert!(company.work_order_ids.contains(&seeded.p1_completed));
    assert!(
        company
            .work_order_ids
            .contains(&seeded.p2_revoked_exclusion_completed)
    );
    assert!(company.work_order_ids.contains(&seeded.p3_completed));
    assert!(!company.work_order_ids.contains(&seeded.p1_boolean_excluded));
    assert!(!company.work_order_ids.contains(&seeded.p2_active_exclusion));
    assert!(!company.work_order_ids.contains(&seeded.p1_outside_period));
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn average_response_speed_uses_first_in_progress_status_history(pool: PgPool) {
    seed_golden_dataset(&pool).await;
    let report = company_report(&pool).await;
    let company = report.rollup(&KpiRollupScope::Company).unwrap();

    assert_eq!(company.average_response_seconds, Some(7_200));
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn completion_duration_and_due_compliance_use_final_approval_timestamp(pool: PgPool) {
    seed_golden_dataset(&pool).await;
    let report = company_report(&pool).await;
    let company = report.rollup(&KpiRollupScope::Company).unwrap();

    assert_eq!(company.average_completion_seconds, Some(172_800));
    assert_eq!(company.target_due_compliance_bps, Some(5_000));
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn revisit_rate_uses_revisit_required_approved_reports(pool: PgPool) {
    seed_golden_dataset(&pool).await;
    let report = company_report(&pool).await;
    let company = report.rollup(&KpiRollupScope::Company).unwrap();

    assert_eq!(company.revisit_rate_bps, 2_500);
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn delay_rate_and_reason_distribution_ignore_excluded_records(pool: PgPool) {
    seed_golden_dataset(&pool).await;
    let report = company_report(&pool).await;
    let company = report.rollup(&KpiRollupScope::Company).unwrap();

    assert_eq!(company.delay_rate_bps, 2_500);
    assert_eq!(
        company
            .delay_reason_distribution
            .get("MECHANIC_OVERLOADED")
            .copied(),
        Some(1)
    );
    assert_eq!(
        company
            .delay_reason_distribution
            .get("OUTSOURCE_DELAY")
            .copied(),
        None
    );
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn inspection_plan_completion_uses_regular_inspection_schedules(pool: PgPool) {
    let seeded = seed_golden_dataset(&pool).await;
    seed_inspection_schedule(
        &pool,
        seeded.branch_a,
        seeded.equipment_a,
        seeded.tech_a,
        time::macros::date!(2026 - 06 - 10),
        Some(PERIOD_START + Duration::days(9) + Duration::hours(10)),
    )
    .await;
    seed_inspection_schedule(
        &pool,
        seeded.branch_a,
        seeded.equipment_a,
        seeded.tech_a,
        time::macros::date!(2026 - 06 - 20),
        None,
    )
    .await;
    seed_inspection_schedule(
        &pool,
        seeded.branch_b,
        seeded.equipment_b,
        seeded.tech_b,
        time::macros::date!(2026 - 06 - 15),
        Some(PERIOD_START + Duration::days(14) + Duration::hours(9)),
    )
    .await;
    seed_inspection_schedule(
        &pool,
        seeded.branch_a,
        seeded.equipment_a,
        seeded.tech_a,
        time::macros::date!(2026 - 07 - 01),
        Some(PERIOD_END + Duration::hours(9)),
    )
    .await;
    let report = company_report(&pool).await;

    assert!(
        report
            .unavailable_metric(KpiMetric::InspectionPlanCompletionRate)
            .is_none()
    );
    let company = report.rollup(&KpiRollupScope::Company).unwrap();
    assert_eq!(company.inspection_schedule_due_count, 3);
    assert_eq!(company.inspection_schedule_completed_count, 2);
    assert_eq!(company.inspection_plan_completion_bps, Some(6_666));

    let branch_a = report
        .rollup(&KpiRollupScope::Branch(seeded.branch_a))
        .unwrap();
    assert_eq!(branch_a.inspection_schedule_due_count, 2);
    assert_eq!(branch_a.inspection_schedule_completed_count, 1);
    assert_eq!(branch_a.inspection_plan_completion_bps, Some(5_000));

    let tech_b = report
        .rollup(&KpiRollupScope::Technician(seeded.tech_b))
        .unwrap();
    assert_eq!(tech_b.inspection_schedule_due_count, 1);
    assert_eq!(tech_b.inspection_schedule_completed_count, 1);
    assert_eq!(tech_b.inspection_plan_completion_bps, Some(10_000));
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn p1_acceptance_rate_is_honestly_unavailable_without_dispatch_tables(pool: PgPool) {
    seed_golden_dataset(&pool).await;
    let report = company_report(&pool).await;

    let unavailable = report
        .unavailable_metric(KpiMetric::P1AcceptanceRate)
        .unwrap();
    assert_eq!(unavailable.source_domain, "dispatch");
    assert!(unavailable.reason.contains("P1 dispatch broadcast"));
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn rollups_respect_branch_scope_across_two_branches(pool: PgPool) {
    let seeded = seed_golden_dataset(&pool).await;
    let repo = PgKpiRepository::new(pool.clone());
    let report = repo
        .query_kpis(KpiQuery {
            period: period(),
            scope: KpiScope::Company,
            branch_scope: BranchScope::single(seeded.branch_a),
        })
        .await
        .unwrap();

    assert!(
        report
            .rollup(&KpiRollupScope::Branch(seeded.branch_a))
            .is_some()
    );
    assert!(
        report
            .rollup(&KpiRollupScope::Branch(seeded.branch_b))
            .is_none()
    );
    assert_eq!(
        report
            .rollup(&KpiRollupScope::Technician(seeded.tech_a))
            .unwrap()
            .completed_count,
        2
    );
    assert!(
        report
            .rollup(&KpiRollupScope::Technician(seeded.tech_b))
            .is_none()
    );
}

async fn company_report(pool: &PgPool) -> mnt_reporting_domain::KpiReport {
    let repo = PgKpiRepository::new(pool.clone());
    repo.query_kpis(KpiQuery {
        period: period(),
        scope: KpiScope::Company,
        branch_scope: BranchScope::All,
    })
    .await
    .unwrap()
}

const fn period() -> Period {
    Period {
        start: PERIOD_START,
        end: PERIOD_END,
    }
}

struct SeededGoldenDataset {
    branch_a: BranchId,
    branch_b: BranchId,
    tech_a: UserId,
    tech_b: UserId,
    equipment_a: uuid::Uuid,
    equipment_b: uuid::Uuid,
    p1_completed: uuid::Uuid,
    p2_revoked_exclusion_completed: uuid::Uuid,
    p3_completed: uuid::Uuid,
    p1_boolean_excluded: uuid::Uuid,
    p2_active_exclusion: uuid::Uuid,
    p1_outside_period: uuid::Uuid,
}

async fn seed_golden_dataset(pool: &PgPool) -> SeededGoldenDataset {
    let region_a = seed_region(pool, "수도권").await;
    let region_b = seed_region(pool, "충청").await;
    let branch_a = seed_branch(pool, region_a, "서울").await;
    let branch_b = seed_branch(pool, region_b, "천안").await;
    let receptionist = seed_user(pool, "접수", "RECEPTIONIST", branch_a).await;
    let tech_a = seed_user(pool, "정비A", "MECHANIC", branch_a).await;
    let tech_b = seed_user(pool, "정비B", "MECHANIC", branch_b).await;
    let admin = seed_user(pool, "관리자", "ADMIN", branch_a).await;
    let executive = seed_user(pool, "임원", "EXECUTIVE", branch_a).await;
    let equipment_a = seed_equipment(pool, branch_a, "290", "A").await;
    let equipment_b = seed_equipment(pool, branch_b, "777", "B").await;

    let p1_completed = seed_work_order(
        pool,
        WorkOrderFixture {
            branch: branch_a,
            equipment: equipment_a,
            requested_by: receptionist,
            technician: tech_a,
            admin,
            executive,
            request_no: "20260601-001",
            priority: "P1",
            status: "FINAL_COMPLETED",
            result_type: "COMPLETED",
            delay_reason: None,
            kpi_excluded: false,
            created_at: PERIOD_START + Duration::hours(8),
            started_at: Some(PERIOD_START + Duration::hours(9)),
            approved_at: PERIOD_START + Duration::days(1) + Duration::hours(8),
            target_due_at: Some(PERIOD_START + Duration::days(1) + Duration::hours(9)),
        },
    )
    .await;
    let p2_revoked_exclusion_completed = seed_work_order(
        pool,
        WorkOrderFixture {
            branch: branch_a,
            equipment: equipment_a,
            requested_by: receptionist,
            technician: tech_a,
            admin,
            executive,
            request_no: "20260601-002",
            priority: "P2",
            status: "FINAL_COMPLETED",
            result_type: "COMPLETED",
            delay_reason: Some("MECHANIC_OVERLOADED"),
            kpi_excluded: false,
            created_at: PERIOD_START + Duration::hours(7),
            started_at: Some(PERIOD_START + Duration::hours(9)),
            approved_at: PERIOD_START + Duration::days(2) + Duration::hours(7),
            target_due_at: Some(PERIOD_START + Duration::days(1)),
        },
    )
    .await;
    seed_kpi_exclusion(
        pool,
        branch_a,
        "WORK_ORDER",
        p2_revoked_exclusion_completed,
        admin,
        true,
    )
    .await;

    let p3_completed = seed_work_order(
        pool,
        WorkOrderFixture {
            branch: branch_b,
            equipment: equipment_b,
            requested_by: receptionist,
            technician: tech_b,
            admin,
            executive,
            request_no: "20260601-003",
            priority: "P3",
            status: "FINAL_COMPLETED",
            result_type: "COMPLETED",
            delay_reason: None,
            kpi_excluded: false,
            created_at: PERIOD_START + Duration::hours(6),
            started_at: Some(PERIOD_START + Duration::hours(9)),
            approved_at: PERIOD_START + Duration::days(3) + Duration::hours(6),
            target_due_at: None,
        },
    )
    .await;

    let revisit_approved = seed_work_order(
        pool,
        WorkOrderFixture {
            branch: branch_b,
            equipment: equipment_b,
            requested_by: receptionist,
            technician: tech_b,
            admin,
            executive,
            request_no: "20260601-004",
            priority: "P2",
            status: "TEMPORARY_ACTION",
            result_type: "REVISIT_REQUIRED",
            delay_reason: None,
            kpi_excluded: false,
            created_at: PERIOD_START + Duration::hours(5),
            started_at: Some(PERIOD_START + Duration::hours(7)),
            approved_at: PERIOD_START + Duration::days(1) + Duration::hours(5),
            target_due_at: None,
        },
    )
    .await;
    assert_ne!(revisit_approved, uuid::Uuid::nil());

    let p1_boolean_excluded = seed_work_order(
        pool,
        WorkOrderFixture {
            branch: branch_a,
            equipment: equipment_a,
            requested_by: receptionist,
            technician: tech_a,
            admin,
            executive,
            request_no: "20260601-005",
            priority: "P1",
            status: "FINAL_COMPLETED",
            result_type: "COMPLETED",
            delay_reason: None,
            kpi_excluded: true,
            created_at: PERIOD_START,
            started_at: Some(PERIOD_START + Duration::hours(1)),
            approved_at: PERIOD_START + Duration::days(1),
            target_due_at: None,
        },
    )
    .await;

    let p2_active_exclusion = seed_work_order(
        pool,
        WorkOrderFixture {
            branch: branch_b,
            equipment: equipment_b,
            requested_by: receptionist,
            technician: tech_b,
            admin,
            executive,
            request_no: "20260601-006",
            priority: "P2",
            status: "FINAL_COMPLETED",
            result_type: "COMPLETED",
            delay_reason: Some("OUTSOURCE_DELAY"),
            kpi_excluded: false,
            created_at: PERIOD_START,
            started_at: Some(PERIOD_START + Duration::hours(1)),
            approved_at: PERIOD_START + Duration::days(1),
            target_due_at: None,
        },
    )
    .await;
    seed_kpi_exclusion(
        pool,
        branch_b,
        "WORK_ORDER",
        p2_active_exclusion,
        admin,
        false,
    )
    .await;

    let p1_outside_period = seed_work_order(
        pool,
        WorkOrderFixture {
            branch: branch_a,
            equipment: equipment_a,
            requested_by: receptionist,
            technician: tech_a,
            admin,
            executive,
            request_no: "20260501-001",
            priority: "P1",
            status: "FINAL_COMPLETED",
            result_type: "COMPLETED",
            delay_reason: None,
            kpi_excluded: false,
            created_at: PERIOD_START - Duration::days(40),
            started_at: Some(PERIOD_START - Duration::days(40) + Duration::hours(1)),
            approved_at: PERIOD_START - Duration::days(30),
            target_due_at: None,
        },
    )
    .await;

    SeededGoldenDataset {
        branch_a,
        branch_b,
        tech_a,
        tech_b,
        equipment_a,
        equipment_b,
        p1_completed,
        p2_revoked_exclusion_completed,
        p3_completed,
        p1_boolean_excluded,
        p2_active_exclusion,
        p1_outside_period,
    }
}

async fn seed_region(pool: &PgPool, name: &str) -> RegionId {
    let id = sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
        .bind(format!("{name}-{}", uuid::Uuid::new_v4()))
        .bind(*OrgId::knl().as_uuid())
        .fetch_one(pool)
        .await
        .unwrap();
    RegionId::from_uuid(id)
}

async fn seed_branch(pool: &PgPool, region: RegionId, name: &str) -> BranchId {
    let id = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(*region.as_uuid())
    .bind(format!("{name}-{}", uuid::Uuid::new_v4()))
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    BranchId::from_uuid(id)
}

async fn seed_user(pool: &PgPool, name: &str, role: &str, branch: BranchId) -> UserId {
    let id = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*id.as_uuid())
        .bind(format!("{name}-{}", uuid::Uuid::new_v4()))
        .bind(Vec::from([role]))
        .bind(*OrgId::knl().as_uuid())
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(*id.as_uuid())
        .bind(*branch.as_uuid())
        .bind(*OrgId::knl().as_uuid())
        .execute(pool)
        .await
        .unwrap();
    id
}

async fn seed_equipment(
    pool: &PgPool,
    branch: BranchId,
    management_no: &str,
    suffix: &str,
) -> uuid::Uuid {
    let customer_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO registry_customers (branch_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(*branch.as_uuid())
    .bind(format!("고객-{suffix}-{}", uuid::Uuid::new_v4()))
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    let site_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO registry_sites (branch_id, customer_id, name, org_id) VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(*branch.as_uuid())
    .bind(customer_id)
    .bind(format!("현장-{suffix}"))
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query_scalar(
        r#"
        INSERT INTO registry_equipment (
            branch_id, customer_id, site_id, equipment_no, management_no, model,
            manufacturer_code, kind_code, power_code, status, specification, ton_text,
            rental_fee, vehicle_value, residual_value, source_sheet, source_row, updated_at, org_id
        )
        VALUES ($1, $2, $3, $4, $5, 'FBR', 'GLD', 'FBR', 'BATTERY', '임대',
                '입식', '1.5톤', 700000, 10000000, 5000000, 'golden', 1, now(), $6)
        RETURNING id
        "#,
    )
    .bind(*branch.as_uuid())
    .bind(customer_id)
    .bind(site_id)
    .bind(match suffix {
        "A" => "GOLAA-0290",
        "B" => "GOLBB-0777",
        _ => "GOLZZ-0001",
    })
    .bind(management_no)
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn seed_inspection_schedule(
    pool: &PgPool,
    branch: BranchId,
    equipment: uuid::Uuid,
    mechanic: UserId,
    due_date: time::Date,
    completed_at: Option<OffsetDateTime>,
) -> uuid::Uuid {
    sqlx::query_scalar(
        r#"
        INSERT INTO regular_inspection_schedules (
            branch_id, equipment_id, mechanic_id, cycle, interval_days, due_date,
            status, completed_at, completed_by, note, created_by, created_at, updated_at, org_id
        )
        VALUES (
            $1, $2, $3, 'MONTHLY', 30, $4,
            $5, $6, $7, 'golden inspection', $3, $8, $8, $9
        )
        RETURNING id
        "#,
    )
    .bind(*branch.as_uuid())
    .bind(equipment)
    .bind(*mechanic.as_uuid())
    .bind(due_date)
    .bind(if completed_at.is_some() {
        "COMPLETED"
    } else {
        "SCHEDULED"
    })
    .bind(completed_at)
    .bind(completed_at.map(|_| *mechanic.as_uuid()))
    .bind(PERIOD_START)
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap()
}

struct WorkOrderFixture {
    branch: BranchId,
    equipment: uuid::Uuid,
    requested_by: UserId,
    technician: UserId,
    admin: UserId,
    executive: UserId,
    request_no: &'static str,
    priority: &'static str,
    status: &'static str,
    result_type: &'static str,
    delay_reason: Option<&'static str>,
    kpi_excluded: bool,
    created_at: OffsetDateTime,
    started_at: Option<OffsetDateTime>,
    approved_at: OffsetDateTime,
    target_due_at: Option<OffsetDateTime>,
}

async fn seed_work_order(pool: &PgPool, fixture: WorkOrderFixture) -> uuid::Uuid {
    let ids: (uuid::Uuid, uuid::Uuid, uuid::Uuid) = sqlx::query_as(
        "SELECT customer_id, site_id, branch_id FROM registry_equipment WHERE id = $1",
    )
    .bind(fixture.equipment)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(ids.2, *fixture.branch.as_uuid());

    let work_order_id: uuid::Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO work_orders (
            request_no, branch_id, equipment_id, customer_id, site_id, requested_by,
            status, priority, symptom, target_due_at, delay_reason, result_type,
            report_submitted_by, report_submitted_at, kpi_excluded, created_at, updated_at, org_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'golden symptom', $9, $10, $11,
                $12, $13, $14, $15, $16, $17)
        RETURNING id
        "#,
    )
    .bind(fixture.request_no)
    .bind(*fixture.branch.as_uuid())
    .bind(fixture.equipment)
    .bind(ids.0)
    .bind(ids.1)
    .bind(*fixture.requested_by.as_uuid())
    .bind(fixture.status)
    .bind(fixture.priority)
    .bind(fixture.target_due_at)
    .bind(fixture.delay_reason)
    .bind(fixture.result_type)
    .bind(*fixture.technician.as_uuid())
    .bind(fixture.approved_at - Duration::hours(4))
    .bind(fixture.kpi_excluded)
    .bind(fixture.created_at)
    .bind(fixture.approved_at)
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();

    sqlx::query("INSERT INTO work_order_assignments (work_order_id, mechanic_id, role, assigned_at, org_id) VALUES ($1, $2, 'PRIMARY', $3, $4)")
        .bind(work_order_id)
        .bind(*fixture.technician.as_uuid())
        .bind(fixture.created_at + Duration::minutes(15))
        .bind(*OrgId::knl().as_uuid())
        .execute(pool)
        .await
        .unwrap();
    seed_approval_step(
        pool,
        work_order_id,
        1,
        "MECHANIC",
        fixture.technician,
        fixture.approved_at - Duration::hours(4),
    )
    .await;
    seed_approval_step(
        pool,
        work_order_id,
        2,
        "ADMIN",
        fixture.admin,
        fixture.approved_at - Duration::hours(2),
    )
    .await;
    seed_approval_step(
        pool,
        work_order_id,
        3,
        "EXECUTIVE",
        fixture.executive,
        fixture.approved_at,
    )
    .await;

    sqlx::query(
        "INSERT INTO work_order_status_history (work_order_id, actor, action, from_status, to_status, occurred_at, org_id) VALUES ($1, $2, 'work_order.create', NULL, 'RECEIVED', $3, $4)",
    )
    .bind(work_order_id)
    .bind(*fixture.requested_by.as_uuid())
    .bind(fixture.created_at)
    .bind(*OrgId::knl().as_uuid())
    .execute(pool)
    .await
    .unwrap();
    if let Some(started_at) = fixture.started_at {
        sqlx::query(
            "INSERT INTO work_order_status_history (work_order_id, actor, action, from_status, to_status, occurred_at, org_id) VALUES ($1, $2, 'work_order.start', 'ASSIGNED', 'IN_PROGRESS', $3, $4)",
        )
        .bind(work_order_id)
        .bind(*fixture.technician.as_uuid())
        .bind(started_at)
        .bind(*OrgId::knl().as_uuid())
        .execute(pool)
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO work_order_status_history (work_order_id, actor, action, from_status, to_status, occurred_at, org_id) VALUES ($1, $2, 'work_order.approve', 'ADMIN_REVIEW', $3, $4, $5)",
    )
    .bind(work_order_id)
    .bind(*fixture.executive.as_uuid())
    .bind(fixture.status)
    .bind(fixture.approved_at)
    .bind(*OrgId::knl().as_uuid())
    .execute(pool)
    .await
    .unwrap();

    work_order_id
}

async fn seed_approval_step(
    pool: &PgPool,
    work_order_id: uuid::Uuid,
    step_order: i16,
    role: &str,
    approver: UserId,
    approved_at: OffsetDateTime,
) {
    sqlx::query(
        r#"
        INSERT INTO work_order_approval_steps (
            work_order_id, step_order, role, approver_id, status,
            requested_at, approved_at, approved_by_id, org_id
        )
        VALUES ($1, $2, $3, $4, 'APPROVED', $5, $5, $4, $6)
        "#,
    )
    .bind(work_order_id)
    .bind(step_order)
    .bind(role)
    .bind(*approver.as_uuid())
    .bind(approved_at)
    .bind(*OrgId::knl().as_uuid())
    .execute(pool)
    .await
    .unwrap();
}

async fn seed_kpi_exclusion(
    pool: &PgPool,
    branch: BranchId,
    scope: &str,
    target_id: uuid::Uuid,
    actor: UserId,
    revoked: bool,
) {
    let revoked_by = revoked.then_some(*actor.as_uuid());
    let revoked_at = revoked.then_some(PERIOD_START + Duration::days(10));
    sqlx::query(
        r#"
        INSERT INTO kpi_exclusions (
            branch_id, scope, target_id, reason, excluded_by, excluded_at, revoked_by, revoked_at, org_id
        )
        VALUES ($1, $2, $3, 'golden exclusion', $4, $5, $6, $7, $8)
        "#,
    )
    .bind(*branch.as_uuid())
    .bind(scope)
    .bind(target_id)
    .bind(*actor.as_uuid())
    .bind(PERIOD_START + Duration::days(1))
    .bind(revoked_by)
    .bind(revoked_at)
    .bind(*OrgId::knl().as_uuid())
    .execute(pool)
    .await
    .unwrap();
}
