#![allow(clippy::expect_used, clippy::panic, clippy::unwrap_used)]

use std::time::Duration as StdDuration;

use mnt_kernel_core::{FixedClock, Timestamp};
use mnt_platform_jobs::{
    ApalisPostgresJobQueue, JobQueue, JobRequest, SkewedClock,
    soak::{self, APALIS_POSTGRES_VERSION, APALIS_VERSION},
};
use sqlx::Row;

#[test]
fn crate_versions_are_pinned_to_live_verified_rcs() {
    assert_eq!(APALIS_VERSION, "1.0.0-rc.9");
    assert_eq!(APALIS_POSTGRES_VERSION, "1.0.0-rc.8");
    let stable_available = soak::APALIS_STABLE_1_0_0_AVAILABLE;
    assert!(!stable_available);
}

#[test]
fn skewed_clock_drives_schedule_after() {
    let base = time::macros::datetime!(2026-06-12 09:00:00 UTC);
    let clock = FixedClock(base);
    let skewed = SkewedClock::new(&clock, time::Duration::milliseconds(-750));

    let scheduled = mnt_platform_jobs::schedule_after(&skewed, StdDuration::from_millis(1_750))
        .expect("skewed schedule should be valid");

    assert_eq!(scheduled, time::macros::datetime!(2026-06-12 09:00:01 UTC));
}

#[tokio::test]
async fn apalis_adapter_dedupes_repeated_idempotency_keys() {
    let database_url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL is required for apalis adapter test");
    let queue_name = format!("mnt.t110.adapter-test.{}", uuid::Uuid::new_v4());
    let queue = ApalisPostgresJobQueue::connect(&database_url, &queue_name)
        .await
        .expect("setup apalis queue");
    let workspace_pool = sqlx::PgPool::connect(&database_url)
        .await
        .expect("connect workspace sqlx pool");
    let scheduled_for: Timestamp = time::OffsetDateTime::now_utc() + time::Duration::seconds(60);
    let key = format!("adapter-test:{}", uuid::Uuid::new_v4());
    let request = JobRequest::escalation_timer("adapter-test", "timer-001", scheduled_for, &key)
        .expect("valid job request");

    queue
        .schedule_at(request.clone(), scheduled_for)
        .await
        .expect("first enqueue succeeds");
    queue
        .schedule_at(request, scheduled_for)
        .await
        .expect("second enqueue is idempotent");

    let row = sqlx::query(
        r#"
        SELECT COUNT(*)::BIGINT
        FROM apalis.jobs
        WHERE job_type = $1 AND idempotency_key = $2
        "#,
    )
    .bind(&queue_name)
    .bind(&key)
    .fetch_one(&workspace_pool)
    .await
    .expect("count apalis jobs");
    let count: i64 = row.try_get(0).expect("count column");
    assert_eq!(count, 1);

    sqlx::query("DELETE FROM apalis.jobs WHERE job_type = $1")
        .bind(&queue_name)
        .execute(&workspace_pool)
        .await
        .expect("cleanup apalis jobs");
}
