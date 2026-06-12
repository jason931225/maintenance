#![allow(clippy::unwrap_used)]

use mnt_compliance_adapter_postgres::PgComplianceStore;
use mnt_compliance_application::{ConsentTransitionCommand, ConsentTransitionKind};
use mnt_compliance_domain::{LocationPing, PingVolumeBound};
use mnt_kernel_core::{BranchId, LocationPingId, TraceContext, UserId};
use sqlx::{PgPool, Row};
use std::sync::Arc;
use time::{Duration, OffsetDateTime, macros::datetime};

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn withdrawal_destroys_pings_and_logs_while_auditing_only_consent(pool: PgPool) {
    let (user_id, branch_id) = seed_user_and_branch(&pool, "Consent User").await;
    let store = PgComplianceStore::new(pool.clone());

    store
        .transition_consent(command(
            ConsentTransitionKind::Grant,
            user_id,
            branch_id,
            datetime!(2026-06-12 08:00:00 UTC),
        ))
        .await
        .unwrap();

    for (lat, lon, recorded_at) in [
        (37.5665, 126.9780, datetime!(2026-06-12 09:00:00 UTC)),
        (37.5670, 126.9790, datetime!(2026-06-12 09:00:30 UTC)),
    ] {
        let ping = LocationPing::new(
            LocationPingId::new(),
            user_id,
            branch_id,
            lat,
            lon,
            Some(7.0),
            recorded_at,
            true,
        )
        .unwrap();
        store.record_location_ping(ping).await.unwrap();
    }

    assert_eq!(count_location_pings(&pool, user_id).await, 2);
    assert_eq!(count_collection_logs(&pool, user_id).await, 2);

    store
        .transition_consent(command(
            ConsentTransitionKind::Withdraw,
            user_id,
            branch_id,
            datetime!(2026-06-12 10:00:00 UTC),
        ))
        .await
        .unwrap();

    assert_eq!(count_location_pings(&pool, user_id).await, 0);
    assert_eq!(count_collection_logs(&pool, user_id).await, 0);

    let status: String =
        sqlx::query_scalar("SELECT status FROM location_consents WHERE user_id = $1")
            .bind(*user_id.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "WITHDRAWN");

    let withdraw_audits: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE target_type = 'location_consent' AND action = 'consent.withdraw'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(withdraw_audits, 1);

    let coordinate_audits: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM audit_events
        WHERE COALESCE(before_snap::text, '') || COALESCE(after_snap::text, '')
              ~ '(latitude|longitude|coordinates|37\.5665|126\.9780|37\.5670|126\.9790)'
        "#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(coordinate_audits, 0);
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn retention_purge_drops_expired_day_partitions(pool: PgPool) {
    let (user_id, branch_id) = seed_user_and_branch(&pool, "Retention User").await;
    let store = PgComplianceStore::new(pool.clone());

    store
        .transition_consent(command(
            ConsentTransitionKind::Grant,
            user_id,
            branch_id,
            datetime!(2026-06-09 08:00:00 UTC),
        ))
        .await
        .unwrap();

    for recorded_at in [
        datetime!(2026-06-10 09:00:00 UTC),
        datetime!(2026-06-12 09:00:00 UTC),
    ] {
        let ping = LocationPing::new(
            LocationPingId::new(),
            user_id,
            branch_id,
            37.5665,
            126.9780,
            None,
            recorded_at,
            true,
        )
        .unwrap();
        store.record_location_ping(ping).await.unwrap();
    }

    assert!(partition_exists(&pool, "location_pings_20260610").await);
    assert!(partition_exists(&pool, "location_pings_20260612").await);

    let purge = store
        .purge_expired_location_data(datetime!(2026-06-11 00:00:00 UTC))
        .await
        .unwrap();

    assert_eq!(purge.dropped_ping_partitions, 1);
    assert_eq!(purge.deleted_collection_logs, 1);
    assert!(!partition_exists(&pool, "location_pings_20260610").await);
    assert!(partition_exists(&pool, "location_pings_20260612").await);
    assert_eq!(count_location_pings(&pool, user_id).await, 1);
    assert_eq!(count_collection_logs(&pool, user_id).await, 1);
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn ping_volume_stays_within_on_duty_window_rate_bound(pool: PgPool) {
    let (first_user, branch_id) = seed_user_and_branch(&pool, "Volume User 1").await;
    let (second_user, _) = seed_user_in_branch(&pool, branch_id, "Volume User 2").await;
    let store = PgComplianceStore::new(pool.clone());

    for user_id in [first_user, second_user] {
        store
            .transition_consent(command(
                ConsentTransitionKind::Grant,
                user_id,
                branch_id,
                datetime!(2026-06-12 08:00:00 UTC),
            ))
            .await
            .unwrap();
    }

    for (user_id, second_offset) in [(first_user, 0), (first_user, 1), (second_user, 0)] {
        let ping = LocationPing::new(
            LocationPingId::new(),
            user_id,
            branch_id,
            37.5665,
            126.9780,
            None,
            datetime!(2026-06-12 09:00:00 UTC) + Duration::seconds(second_offset),
            true,
        )
        .unwrap();
        store.record_location_ping(ping).await.unwrap();
    }

    let observed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM location_pings")
        .fetch_one(&pool)
        .await
        .unwrap();
    let bound = PingVolumeBound::new(2, Duration::hours(1), Duration::minutes(30)).unwrap();
    assert!(bound.allows(u64::try_from(observed).unwrap()));
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn concurrent_first_pings_for_same_day_share_partition_creation(pool: PgPool) {
    let (user_id, branch_id) = seed_user_and_branch(&pool, "Concurrent User").await;
    let store = Arc::new(PgComplianceStore::new(pool.clone()));

    store
        .transition_consent(command(
            ConsentTransitionKind::Grant,
            user_id,
            branch_id,
            datetime!(2026-06-14 08:00:00 UTC),
        ))
        .await
        .unwrap();

    let mut handles = Vec::new();
    for offset in 0..32 {
        let store = Arc::clone(&store);
        handles.push(tokio::spawn(async move {
            let ping = LocationPing::new(
                LocationPingId::new(),
                user_id,
                branch_id,
                37.5665,
                126.9780,
                None,
                datetime!(2026-06-14 09:00:00 UTC) + Duration::seconds(offset),
                true,
            )
            .unwrap();
            store.record_location_ping(ping).await
        }));
    }

    for handle in handles {
        handle.await.unwrap().unwrap();
    }

    assert!(partition_exists(&pool, "location_pings_20260614").await);
    assert_eq!(count_location_pings(&pool, user_id).await, 32);
    assert_eq!(count_collection_logs(&pool, user_id).await, 32);
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

async fn seed_user_and_branch(pool: &PgPool, display_name: &str) -> (UserId, BranchId) {
    let region_id: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO regions (name) VALUES ($1) RETURNING id")
            .bind(format!("{display_name} Region"))
            .fetch_one(pool)
            .await
            .unwrap();

    let branch_id: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO branches (region_id, name) VALUES ($1, $2) RETURNING id")
            .bind(region_id)
            .bind(format!("{display_name} Branch"))
            .fetch_one(pool)
            .await
            .unwrap();

    seed_user_in_branch(pool, BranchId::from_uuid(branch_id), display_name).await
}

async fn seed_user_in_branch(
    pool: &PgPool,
    branch_id: BranchId,
    display_name: &str,
) -> (UserId, BranchId) {
    let user_id: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO users (display_name, roles) VALUES ($1, $2) RETURNING id")
            .bind(display_name)
            .bind(Vec::<String>::from(["MECHANIC".to_string()]))
            .fetch_one(pool)
            .await
            .unwrap();

    sqlx::query("INSERT INTO user_branches (user_id, branch_id) VALUES ($1, $2)")
        .bind(user_id)
        .bind(*branch_id.as_uuid())
        .execute(pool)
        .await
        .unwrap();

    (UserId::from_uuid(user_id), branch_id)
}

async fn count_location_pings(pool: &PgPool, user_id: UserId) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM location_pings WHERE user_id = $1")
        .bind(*user_id.as_uuid())
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn count_collection_logs(pool: &PgPool, user_id: UserId) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM location_collection_logs WHERE user_id = $1")
        .bind(*user_id.as_uuid())
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn partition_exists(pool: &PgPool, partition: &str) -> bool {
    let row = sqlx::query("SELECT to_regclass($1) IS NOT NULL AS exists")
        .bind(format!("public.{partition}"))
        .fetch_one(pool)
        .await
        .unwrap();
    row.get("exists")
}
