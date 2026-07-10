#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use mnt_dispatch_adapter_postgres::{PgDispatchStore, dispatch_response};
use mnt_dispatch_application::{
    ExpireP1DispatchCommand, ForceAssignP1DispatchCommand, IncidentLocationInput,
    RespondP1DispatchCommand, StartP1DispatchCommand,
};
use mnt_dispatch_domain::{DispatchResponseKind, DispatchStatus, DispatchTimerConfig};
use mnt_kernel_core::{BranchId, ErrorKind, OrgId, TraceContext, UserId, WorkOrderId};
use sqlx::{PgPool, Row};
use time::macros::datetime;

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn two_accepts_auto_assign_best_gps_candidate_and_audit(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let seeded = seed_dispatch_context(&pool).await;
        let store = PgDispatchStore::new(pool.clone());
        let now = datetime!(2026-06-12 09:00 UTC);

        let started = store
            .start_dispatch(
                StartP1DispatchCommand {
                    actor: seeded.receptionist,
                    work_order_id: seeded.work_order_id,
                    incident_location: Some(IncidentLocationInput {
                        latitude: 37.5651,
                        longitude: 126.9895,
                    }),
                    include_region: false,
                    trace: TraceContext::generate(),
                    occurred_at: now,
                },
                DispatchTimerConfig::default(),
            )
            .await
            .unwrap();
        assert_eq!(started.status, DispatchStatus::Broadcasting);
        assert_eq!(started.target_count, 4);
        assert!(!target_exists(&pool, started.id, seeded.off_duty_mechanic).await);

        let fanout_seconds: f64 = sqlx::query_scalar(
            r#"
            SELECT EXTRACT(EPOCH FROM (MAX(t.fanout_created_at) - d.created_at))::float8
            FROM p1_dispatches d
            JOIN p1_dispatch_targets t ON t.dispatch_id = d.id
            WHERE d.id = $1
            GROUP BY d.id
            "#,
        )
        .bind(*started.id.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(fanout_seconds <= 5.0);

        let off_duty_response = store
            .record_response(
                RespondP1DispatchCommand {
                    actor: seeded.off_duty_mechanic,
                    dispatch_id: started.id,
                    response: DispatchResponseKind::Accept,
                    trace: TraceContext::generate(),
                    occurred_at: now + time::Duration::seconds(20),
                },
                DispatchTimerConfig::default(),
            )
            .await
            .unwrap_err();
        assert_eq!(off_duty_response.kind(), ErrorKind::Forbidden);

        let first = store
            .record_response(
                RespondP1DispatchCommand {
                    actor: seeded.near_mechanic,
                    dispatch_id: started.id,
                    response: DispatchResponseKind::Accept,
                    trace: TraceContext::generate(),
                    occurred_at: now + time::Duration::seconds(30),
                },
                DispatchTimerConfig::default(),
            )
            .await
            .unwrap();
        assert_eq!(first.status, DispatchStatus::Broadcasting);

        let assigned = store
            .record_response(
                RespondP1DispatchCommand {
                    actor: seeded.no_consent_mechanic,
                    dispatch_id: started.id,
                    response: DispatchResponseKind::Accept,
                    trace: TraceContext::generate(),
                    occurred_at: now + time::Duration::seconds(45),
                },
                DispatchTimerConfig::default(),
            )
            .await
            .unwrap();
        assert_eq!(assigned.status, DispatchStatus::AutoAssigned);
        assert_eq!(
            assigned.auto_assigned_mechanic_id,
            Some(seeded.near_mechanic)
        );

        let no_consent_response = dispatch_response(&pool, started.id, seeded.no_consent_mechanic)
            .await
            .unwrap();
        assert!(!no_consent_response.gps_ranked);
        assert_eq!(no_consent_response.distance_meters, None);

        let gps_response = dispatch_response(&pool, started.id, seeded.near_mechanic)
            .await
            .unwrap();
        assert!(gps_response.gps_ranked);
        assert!(gps_response.distance_meters.is_some());

        let status: String = sqlx::query_scalar("SELECT status FROM work_orders WHERE id = $1")
            .bind(*seeded.work_order_id.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(status, "ASSIGNED");
        let primary: uuid::Uuid = sqlx::query_scalar(
            "SELECT mechanic_id FROM work_order_assignments WHERE work_order_id = $1 AND role = 'PRIMARY'",
        )
        .bind(*seeded.work_order_id.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(primary, *seeded.near_mechanic.as_uuid());

        let actions = audit_actions_for_dispatch(&pool, started.id, seeded.work_order_id).await;
        assert!(actions.contains(&"p1_dispatch.start".to_owned()));
        assert_eq!(
            actions
                .iter()
                .filter(|action| action.as_str() == "p1_dispatch.respond")
                .count(),
            2
        );
        assert!(actions.contains(&"p1_dispatch.auto_assign".to_owned()));
        assert!(actions.contains(&"work_order.assign".to_owned()));
    })
    .await;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn no_accept_path_escalates_and_manager_force_assigns(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let seeded = seed_dispatch_context(&pool).await;
        let work_order_id = seed_work_order(&pool, seeded.branch_id, seeded.receptionist, 2).await;
        let store = PgDispatchStore::new(pool.clone());
        let now = datetime!(2026-06-12 09:00 UTC);

        let started = store
            .start_dispatch(
                StartP1DispatchCommand {
                    actor: seeded.receptionist,
                    work_order_id,
                    incident_location: Some(IncidentLocationInput {
                        latitude: 37.5651,
                        longitude: 126.9895,
                    }),
                    include_region: false,
                    trace: TraceContext::generate(),
                    occurred_at: now,
                },
                DispatchTimerConfig::default(),
            )
            .await
            .unwrap();

        store
            .mark_alimtalk_no_ack(ExpireP1DispatchCommand {
                dispatch_id: started.id,
                trace: TraceContext::generate(),
                occurred_at: now + DispatchTimerConfig::default().alimtalk_no_ack_after,
            })
            .await
            .unwrap();
        let pending = store
            .expire_accept_window(ExpireP1DispatchCommand {
                dispatch_id: started.id,
                trace: TraceContext::generate(),
                occurred_at: started.accept_window_ends_at,
            })
            .await
            .unwrap();
        assert_eq!(pending.status, DispatchStatus::ManagerForcePending);
        let alerts = alert_counts(&pool, started.id).await;
        assert!(alerts.manager_force > 0);
        assert!(alerts.alimtalk_no_ack > 0);

        let rejected = store
            .force_assign(ForceAssignP1DispatchCommand {
                actor: seeded.manager,
                dispatch_id: started.id,
                mechanic_id: seeded.off_duty_mechanic,
                trace: TraceContext::generate(),
                occurred_at: now + time::Duration::minutes(5),
            })
            .await
            .unwrap_err();
        assert_eq!(rejected.kind(), ErrorKind::Forbidden);

        let forced = store
            .force_assign(ForceAssignP1DispatchCommand {
                actor: seeded.manager,
                dispatch_id: started.id,
                mechanic_id: seeded.far_mechanic,
                trace: TraceContext::generate(),
                occurred_at: now + time::Duration::minutes(6),
            })
            .await
            .unwrap();
        assert_eq!(forced.status, DispatchStatus::AutoAssigned);
        assert_eq!(forced.auto_assigned_mechanic_id, Some(seeded.far_mechanic));

        let primary: uuid::Uuid = sqlx::query_scalar(
            "SELECT mechanic_id FROM work_order_assignments WHERE work_order_id = $1 AND role = 'PRIMARY'",
        )
        .bind(*work_order_id.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(primary, *seeded.far_mechanic.as_uuid());

        let actions = audit_actions_for_dispatch(&pool, started.id, work_order_id).await;
        assert!(actions.contains(&"p1_dispatch.force_pending".to_owned()));
        assert!(actions.contains(&"p1_dispatch.alimtalk_no_ack".to_owned()));
        assert!(actions.contains(&"p1_dispatch.force_assign".to_owned()));
        assert!(actions.contains(&"work_order.assign".to_owned()));
    })
    .await;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn cross_branch_consented_responder_is_gps_ranked(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        // Consent is per-user (location_consents UNIQUE (user_id)). A mechanic who
        // is a valid target in the dispatch branch but whose consent row was recorded
        // in a *different* branch must still be GPS-ranked, not silently demoted to
        // schedule fallback (degrading P1 emergency dispatch).
        let seeded = seed_dispatch_context(&pool).await;
        let other_branch = seed_branch(&pool).await;
        let cross_branch =
            seed_user(&pool, "Cross branch mechanic", "MECHANIC", seeded.branch_id).await;
        sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
            .bind(*cross_branch.as_uuid())
            .bind(*other_branch.as_uuid())
            .bind(*OrgId::knl().as_uuid())
            .execute(&pool)
            .await
            .unwrap();
        seed_device(&pool, cross_branch).await;
        // The on-duty ping is in the dispatch branch (so the mechanic is a fanout
        // target and has a fresh GPS fix near the incident)...
        seed_raw_ping(
            &pool,
            seeded.branch_id,
            cross_branch,
            37.5652,
            126.9896,
            datetime!(2026-06-12 08:59 UTC),
        )
        .await;
        // ...but their per-user consent row lives in the *other* branch. The old
        // `lc.branch_id = d.branch_id` join would miss it and demote the mechanic.
        sqlx::query(
            r#"
            INSERT INTO location_consents (user_id, branch_id, status, granted_at, updated_at, org_id)
            VALUES ($1, $2, 'GRANTED', $3, $3, $4)
            "#,
        )
        .bind(*cross_branch.as_uuid())
        .bind(*other_branch.as_uuid())
        .bind(datetime!(2026-06-12 08:59 UTC))
        .bind(*OrgId::knl().as_uuid())
        .execute(&pool)
        .await
        .unwrap();

        let store = PgDispatchStore::new(pool.clone());
        let now = datetime!(2026-06-12 09:00 UTC);
        let started = store
            .start_dispatch(
                StartP1DispatchCommand {
                    actor: seeded.receptionist,
                    work_order_id: seeded.work_order_id,
                    incident_location: Some(IncidentLocationInput {
                        latitude: 37.5651,
                        longitude: 126.9895,
                    }),
                    include_region: false,
                    trace: TraceContext::generate(),
                    occurred_at: now,
                },
                DispatchTimerConfig::default(),
            )
            .await
            .unwrap();

        store
            .record_response(
                RespondP1DispatchCommand {
                    actor: cross_branch,
                    dispatch_id: started.id,
                    response: DispatchResponseKind::Accept,
                    trace: TraceContext::generate(),
                    occurred_at: now + time::Duration::seconds(30),
                },
                DispatchTimerConfig::default(),
            )
            .await
            .unwrap();
        // A second accept triggers auto-assign, which runs candidate scoring over all
        // accepters (the path that joins location_consents).
        store
            .record_response(
                RespondP1DispatchCommand {
                    actor: seeded.near_mechanic,
                    dispatch_id: started.id,
                    response: DispatchResponseKind::Accept,
                    trace: TraceContext::generate(),
                    occurred_at: now + time::Duration::seconds(45),
                },
                DispatchTimerConfig::default(),
            )
            .await
            .unwrap();

        let response = dispatch_response(&pool, started.id, cross_branch)
            .await
            .unwrap();
        assert!(
            response.gps_ranked,
            "cross-branch consented responder must be GPS-ranked"
        );
        assert!(response.distance_meters.is_some());
    })
    .await;
}

#[derive(Debug)]
struct SeededDispatchContext {
    branch_id: BranchId,
    receptionist: UserId,
    manager: UserId,
    near_mechanic: UserId,
    far_mechanic: UserId,
    no_consent_mechanic: UserId,
    off_duty_mechanic: UserId,
    work_order_id: WorkOrderId,
}

#[derive(Debug)]
struct AlertCounts {
    manager_force: i64,
    alimtalk_no_ack: i64,
}

async fn seed_dispatch_context(pool: &PgPool) -> SeededDispatchContext {
    let branch_id = seed_branch(pool).await;
    let receptionist = seed_user(pool, "Receptionist", "RECEPTIONIST", branch_id).await;
    let manager = seed_user(pool, "Manager", "ADMIN", branch_id).await;
    let near_mechanic = seed_user(pool, "Near mechanic", "MECHANIC", branch_id).await;
    let far_mechanic = seed_user(pool, "Far mechanic", "MECHANIC", branch_id).await;
    let no_consent_mechanic = seed_user(pool, "No consent mechanic", "MECHANIC", branch_id).await;
    let off_duty_mechanic = seed_user(pool, "Off duty mechanic", "MECHANIC", branch_id).await;
    seed_device(pool, manager).await;
    seed_device(pool, near_mechanic).await;
    seed_device(pool, far_mechanic).await;
    seed_device(pool, no_consent_mechanic).await;
    seed_device(pool, off_duty_mechanic).await;
    seed_location(pool, branch_id, near_mechanic, 37.5652, 126.9897).await;
    seed_location(pool, branch_id, far_mechanic, 37.4979, 127.0276).await;
    seed_raw_ping_without_consent(pool, branch_id, no_consent_mechanic, 37.5650, 126.9894).await;
    seed_off_duty_location(pool, branch_id, off_duty_mechanic, 37.5653, 126.9898).await;
    let work_order_id = seed_work_order(pool, branch_id, receptionist, 1).await;

    SeededDispatchContext {
        branch_id,
        receptionist,
        manager,
        near_mechanic,
        far_mechanic,
        no_consent_mechanic,
        off_duty_mechanic,
        work_order_id,
    }
}

async fn seed_branch(pool: &PgPool) -> BranchId {
    let region_id: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(format!("Dispatch Region {}", uuid::Uuid::new_v4()))
            .bind(*OrgId::knl().as_uuid())
            .fetch_one(pool)
            .await
            .unwrap();
    let branch_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(region_id)
    .bind("Dispatch Branch")
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    BranchId::from_uuid(branch_id)
}

async fn seed_user(pool: &PgPool, name: &str, role: &str, branch_id: BranchId) -> UserId {
    let user_id = UserId::new();
    sqlx::query(
        "INSERT INTO users (id, display_name, phone, roles, org_id) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(*user_id.as_uuid())
    .bind(name)
    .bind(format!("010{}", &user_id.to_string()[..8]))
    .bind(Vec::from([role]))
    .bind(*OrgId::knl().as_uuid())
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(*user_id.as_uuid())
        .bind(*branch_id.as_uuid())
        .bind(*OrgId::knl().as_uuid())
        .execute(pool)
        .await
        .unwrap();
    user_id
}

async fn seed_device(pool: &PgPool, user_id: UserId) {
    sqlx::query(
        r#"
        INSERT INTO registered_devices (
            user_id, device_hash, platform, push_token, app_version,
            last_registered_at, created_at, updated_at, org_id
        )
        VALUES ($1, $2, 'ANDROID', $3, '1.0.0', now(), now(), now(), $4)
        "#,
    )
    .bind(*user_id.as_uuid())
    .bind(format!("{:064x}", user_id.as_uuid().as_u128()))
    .bind(format!("push-token-{user_id}"))
    .bind(*OrgId::knl().as_uuid())
    .execute(pool)
    .await
    .unwrap();
}

async fn seed_location(
    pool: &PgPool,
    branch_id: BranchId,
    user_id: UserId,
    latitude: f64,
    longitude: f64,
) {
    let now = datetime!(2026-06-12 08:59 UTC);
    sqlx::query(
        r#"
        INSERT INTO location_consents (
            user_id, branch_id, status, granted_at, updated_at, org_id
        )
        VALUES ($1, $2, 'GRANTED', $3, $3, $4)
        "#,
    )
    .bind(*user_id.as_uuid())
    .bind(*branch_id.as_uuid())
    .bind(now)
    .bind(*OrgId::knl().as_uuid())
    .execute(pool)
    .await
    .unwrap();
    seed_raw_ping(pool, branch_id, user_id, latitude, longitude, now).await;
}

async fn seed_off_duty_location(
    pool: &PgPool,
    branch_id: BranchId,
    user_id: UserId,
    latitude: f64,
    longitude: f64,
) {
    let now = datetime!(2026-06-12 08:59 UTC);
    sqlx::query(
        r#"
        INSERT INTO location_consents (
            user_id, branch_id, status, granted_at, updated_at, org_id
        )
        VALUES ($1, $2, 'GRANTED', $3, $3, $4)
        "#,
    )
    .bind(*user_id.as_uuid())
    .bind(*branch_id.as_uuid())
    .bind(now)
    .bind(*OrgId::knl().as_uuid())
    .execute(pool)
    .await
    .unwrap();
    seed_raw_ping_with_duty(pool, branch_id, user_id, latitude, longitude, now, false).await;
}

async fn seed_raw_ping_without_consent(
    pool: &PgPool,
    branch_id: BranchId,
    user_id: UserId,
    latitude: f64,
    longitude: f64,
) {
    seed_raw_ping_with_duty(
        pool,
        branch_id,
        user_id,
        latitude,
        longitude,
        datetime!(2026-06-12 08:59 UTC),
        true,
    )
    .await;
}

async fn seed_raw_ping(
    pool: &PgPool,
    branch_id: BranchId,
    user_id: UserId,
    latitude: f64,
    longitude: f64,
    recorded_at: time::OffsetDateTime,
) {
    seed_raw_ping_with_duty(
        pool,
        branch_id,
        user_id,
        latitude,
        longitude,
        recorded_at,
        true,
    )
    .await;
}

async fn seed_raw_ping_with_duty(
    pool: &PgPool,
    branch_id: BranchId,
    user_id: UserId,
    latitude: f64,
    longitude: f64,
    recorded_at: time::OffsetDateTime,
    on_duty: bool,
) {
    sqlx::query_scalar::<_, String>("SELECT location_pings_ensure_partition($1)")
        .bind(recorded_at)
        .fetch_one(pool)
        .await
        .unwrap();
    sqlx::query(
        r#"
        INSERT INTO location_pings (
            user_id, branch_id, latitude, longitude, accuracy_m, recorded_at, on_duty, org_id
        )
        VALUES ($1, $2, $3, $4, 5.0, $5, $6, $7)
        "#,
    )
    .bind(*user_id.as_uuid())
    .bind(*branch_id.as_uuid())
    .bind(latitude)
    .bind(longitude)
    .bind(recorded_at)
    .bind(on_duty)
    .bind(*OrgId::knl().as_uuid())
    .execute(pool)
    .await
    .unwrap();
}

async fn seed_work_order(
    pool: &PgPool,
    branch_id: BranchId,
    requested_by: UserId,
    sequence: i32,
) -> WorkOrderId {
    let customer_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO registry_customers (branch_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(*branch_id.as_uuid())
    .bind(format!("Dispatch Customer {sequence}"))
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    let site_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO registry_sites (branch_id, customer_id, name, org_id) VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(*branch_id.as_uuid())
    .bind(customer_id)
    .bind(format!("Dispatch Site {sequence}"))
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    let equipment_id: uuid::Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO registry_equipment (
            branch_id, customer_id, site_id, equipment_no, management_no,
            manufacturer_code, kind_code, power_code, status,
            specification, ton_text, model, source_sheet, source_row, org_id
        )
        VALUES ($1, $2, $3, $4, $5, 'A', 'B', 'C', '임대',
                '좌식', '2.5', 'GTS25DE', 'dispatch-test', $6, $7)
        RETURNING id
        "#,
    )
    .bind(*branch_id.as_uuid())
    .bind(customer_id)
    .bind(site_id)
    .bind(format!("DSP{sequence:02}-0290"))
    .bind(format!("D{sequence}"))
    .bind(sequence)
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    let work_order_id = WorkOrderId::new();
    sqlx::query(
        r#"
        INSERT INTO work_orders (
            id, request_no, branch_id, equipment_id, customer_id, site_id,
            requested_by, status, priority, symptom, created_at, updated_at, org_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'RECEIVED', 'P1',
                'Emergency dispatch test', now(), now(), $8)
        "#,
    )
    .bind(*work_order_id.as_uuid())
    .bind(format!("20260612-{sequence:03}"))
    .bind(*branch_id.as_uuid())
    .bind(equipment_id)
    .bind(customer_id)
    .bind(site_id)
    .bind(*requested_by.as_uuid())
    .bind(*OrgId::knl().as_uuid())
    .execute(pool)
    .await
    .unwrap();
    work_order_id
}

async fn audit_actions_for_dispatch(
    pool: &PgPool,
    dispatch_id: mnt_kernel_core::P1DispatchId,
    work_order_id: WorkOrderId,
) -> Vec<String> {
    sqlx::query_scalar(
        r#"
        SELECT action
        FROM audit_events
        WHERE target_id = $1 OR target_id = $2
        ORDER BY occurred_at, created_at
        "#,
    )
    .bind(dispatch_id.to_string())
    .bind(work_order_id.to_string())
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn alert_counts(pool: &PgPool, dispatch_id: mnt_kernel_core::P1DispatchId) -> AlertCounts {
    let row = sqlx::query(
        r#"
        SELECT
            COUNT(*) FILTER (WHERE alert_type = 'MANAGER_FORCE_ASSIGN') AS manager_force,
            COUNT(*) FILTER (WHERE alert_type = 'ALIMTALK_NO_ACK') AS alimtalk_no_ack
        FROM p1_dispatch_alerts
        WHERE dispatch_id = $1
        "#,
    )
    .bind(*dispatch_id.as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    AlertCounts {
        manager_force: row.try_get("manager_force").unwrap(),
        alimtalk_no_ack: row.try_get("alimtalk_no_ack").unwrap(),
    }
}

async fn target_exists(
    pool: &PgPool,
    dispatch_id: mnt_kernel_core::P1DispatchId,
    user_id: UserId,
) -> bool {
    sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM p1_dispatch_targets
            WHERE dispatch_id = $1 AND user_id = $2
        )
        "#,
    )
    .bind(*dispatch_id.as_uuid())
    .bind(*user_id.as_uuid())
    .fetch_one(pool)
    .await
    .unwrap()
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn my_pending_offers_lists_only_unanswered_targets(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let seeded = seed_dispatch_context(&pool).await;
        let store = PgDispatchStore::new(pool.clone());
        let now = datetime!(2026-06-12 09:00 UTC);

        let started = store
            .start_dispatch(
                StartP1DispatchCommand {
                    actor: seeded.receptionist,
                    work_order_id: seeded.work_order_id,
                    incident_location: Some(IncidentLocationInput {
                        latitude: 37.5651,
                        longitude: 126.9895,
                    }),
                    include_region: false,
                    trace: TraceContext::generate(),
                    occurred_at: now,
                },
                DispatchTimerConfig::default(),
            )
            .await
            .unwrap();

        // The targeted mechanic sees exactly one pending offer, addressed at
        // the started dispatch, inside the accept window.
        let offers = store
            .list_my_pending_offers(seeded.near_mechanic, now + time::Duration::seconds(5))
            .await
            .unwrap();
        assert_eq!(offers.len(), 1, "targeted mechanic sees the offer");
        assert_eq!(offers[0].dispatch_id, started.id);
        assert_eq!(offers[0].work_order_id, seeded.work_order_id);
        assert!(!offers[0].request_no.is_empty());

        // A user the fan-out never targeted sees nothing (deny-by-omission),
        // and neither does a receptionist.
        let untargeted = store
            .list_my_pending_offers(seeded.off_duty_mechanic, now + time::Duration::seconds(5))
            .await
            .unwrap();
        assert!(untargeted.is_empty(), "untargeted user sees no offers");
        let receptionist = store
            .list_my_pending_offers(seeded.receptionist, now + time::Duration::seconds(5))
            .await
            .unwrap();
        assert!(receptionist.is_empty());

        // After the mechanic responds, the offer leaves their pending list.
        store
            .record_response(
                RespondP1DispatchCommand {
                    actor: seeded.near_mechanic,
                    dispatch_id: started.id,
                    response: DispatchResponseKind::Decline,
                    trace: TraceContext::generate(),
                    occurred_at: now + time::Duration::seconds(20),
                },
                DispatchTimerConfig::default(),
            )
            .await
            .unwrap();
        let after_response = store
            .list_my_pending_offers(seeded.near_mechanic, now + time::Duration::seconds(25))
            .await
            .unwrap();
        assert!(after_response.is_empty(), "answered offer is gone");

        // Past the accept window the offer disappears for everyone.
        let expired = store
            .list_my_pending_offers(seeded.far_mechanic, started.accept_window_ends_at)
            .await
            .unwrap();
        assert!(expired.is_empty(), "window-expired offer is gone");
    })
    .await;
}
