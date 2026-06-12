//! `mnt-platform-jobs` - job queue port plus the apalis-postgres adapter.
//!
//! ADR-0011 keeps apalis isolated behind [`JobQueue`]. The adapter owns apalis'
//! timestamped migrations and `apalis.*` schema; numbered project migrations
//! remain in `mnt-platform-db`.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::{future::Future, pin::Pin, time::Duration as StdDuration};

use apalis::prelude::TaskSink;
use apalis_postgres::{Config, PgPool as ApalisPgPool, PostgresStorage};
use apalis_sql::ext::TaskBuilderExt as _;
use apalis_sqlx::{Connection as _, Executor as _, Row as _};
use mnt_kernel_core::{Clock, Timestamp};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub mod soak;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct IdempotencyKey(String);

impl IdempotencyKey {
    pub fn new(value: impl Into<String>) -> Result<Self, JobQueueError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(JobQueueError::InvalidIdempotencyKey);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct JobId(String);

impl JobId {
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PlatformJob {
    EscalationTimer(EscalationTimerJob),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EscalationTimerJob {
    pub scenario_id: String,
    pub timer_id: String,
    pub scheduled_for: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobRequest {
    pub job: PlatformJob,
    pub idempotency_key: IdempotencyKey,
}

impl JobRequest {
    pub fn escalation_timer(
        scenario_id: impl Into<String>,
        timer_id: impl Into<String>,
        scheduled_for: Timestamp,
        idempotency_key: impl Into<String>,
    ) -> Result<Self, JobQueueError> {
        Ok(Self {
            job: PlatformJob::EscalationTimer(EscalationTimerJob {
                scenario_id: scenario_id.into(),
                timer_id: timer_id.into(),
                scheduled_for,
            }),
            idempotency_key: IdempotencyKey::new(idempotency_key)?,
        })
    }
}

pub trait JobQueue: Send + Sync {
    fn enqueue<'a>(&'a self, request: JobRequest) -> BoxFuture<'a, Result<JobId, JobQueueError>>;

    fn schedule_at<'a>(
        &'a self,
        request: JobRequest,
        scheduled_at: Timestamp,
    ) -> BoxFuture<'a, Result<JobId, JobQueueError>>;
}

#[derive(Debug, Error)]
pub enum JobQueueError {
    #[error("idempotency key must not be empty")]
    InvalidIdempotencyKey,

    #[error("scheduled timestamp is before the Unix epoch")]
    ScheduledBeforeUnixEpoch,

    #[error("schedule delay is too large")]
    ScheduleDelayTooLarge,

    #[error("apalis-postgres error: {0}")]
    ApalisPostgres(String),

    #[error("apalis task sink error: {0}")]
    ApalisTaskSink(String),

    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),

    #[error("worker error: {0}")]
    Worker(String),

    #[error("soak failed: {0}")]
    Soak(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone)]
pub struct ApalisPostgresJobQueue {
    pool: ApalisPgPool,
    config: Config,
}

impl ApalisPostgresJobQueue {
    pub async fn connect(database_url: &str, queue_name: &str) -> Result<Self, JobQueueError> {
        let pool = ApalisPgPool::connect(database_url)
            .await
            .map_err(|err| JobQueueError::ApalisPostgres(err.to_string()))?;
        Self::from_pool(pool, queue_name).await
    }

    pub(crate) async fn from_pool(
        pool: ApalisPgPool,
        queue_name: &str,
    ) -> Result<Self, JobQueueError> {
        setup_apalis_schema(&pool).await?;
        Ok(Self {
            pool,
            config: Config::new(queue_name),
        })
    }

    pub(crate) async fn from_pool_with_config(
        pool: ApalisPgPool,
        config: Config,
    ) -> Result<Self, JobQueueError> {
        setup_apalis_schema(&pool).await?;
        Ok(Self { pool, config })
    }
}

pub(crate) async fn setup_apalis_schema(pool: &ApalisPgPool) -> Result<(), JobQueueError> {
    const LOCK_ID: i64 = 901_011;

    let mut conn = pool
        .acquire()
        .await
        .map_err(|err| JobQueueError::ApalisPostgres(err.to_string()))?;
    apalis_sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(LOCK_ID)
        .execute(&mut *conn)
        .await
        .map_err(|err| JobQueueError::ApalisPostgres(err.to_string()))?;

    let result = run_apalis_migrations(&mut conn).await;

    let unlock_result = apalis_sqlx::query("SELECT pg_advisory_unlock($1)")
        .bind(LOCK_ID)
        .execute(&mut *conn)
        .await
        .map_err(|err| JobQueueError::ApalisPostgres(err.to_string()));

    result.and(unlock_result.map(|_| ()))
}

async fn run_apalis_migrations(
    conn: &mut apalis_sqlx::pool::PoolConnection<apalis_sqlx::Postgres>,
) -> Result<(), JobQueueError> {
    (&mut **conn)
        .execute(
            r#"
            CREATE TABLE IF NOT EXISTS platform_jobs_apalis_migrations (
                version BIGINT PRIMARY KEY,
                description TEXT NOT NULL,
                installed_on TIMESTAMPTZ NOT NULL DEFAULT now(),
                success BOOLEAN NOT NULL,
                checksum BYTEA NOT NULL,
                execution_time BIGINT NOT NULL
            )
            "#,
        )
        .await
        .map_err(|err| JobQueueError::ApalisPostgres(err.to_string()))?;

    let migrations = PostgresStorage::migrations();
    for migration in migrations.iter() {
        if migration.migration_type.is_down_migration() {
            continue;
        }

        let applied = apalis_sqlx::query(
            r#"
            SELECT checksum, success
            FROM platform_jobs_apalis_migrations
            WHERE version = $1
            "#,
        )
        .bind(migration.version)
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| JobQueueError::ApalisPostgres(err.to_string()))?;

        if let Some(row) = applied {
            let checksum = row
                .try_get::<Vec<u8>, _>("checksum")
                .map_err(|err| JobQueueError::ApalisPostgres(err.to_string()))?;
            let success = row
                .try_get::<bool, _>("success")
                .map_err(|err| JobQueueError::ApalisPostgres(err.to_string()))?;
            if !success {
                return Err(JobQueueError::ApalisPostgres(format!(
                    "apalis migration {} previously failed",
                    migration.version
                )));
            }
            if checksum.as_slice() != migration.checksum.as_ref() {
                return Err(JobQueueError::ApalisPostgres(format!(
                    "apalis migration {} checksum mismatch",
                    migration.version
                )));
            }
            continue;
        }

        let started = std::time::Instant::now();
        let sql = migration.sql.replace(
            "CREATE SCHEMA apalis;",
            "CREATE SCHEMA IF NOT EXISTS apalis;",
        );
        let mut transaction = conn
            .begin()
            .await
            .map_err(|err| JobQueueError::ApalisPostgres(err.to_string()))?;
        (&mut *transaction)
            .execute(sql.as_str())
            .await
            .map_err(|err| {
                JobQueueError::ApalisPostgres(format!(
                    "failed apalis migration {}: {err}",
                    migration.version
                ))
            })?;
        apalis_sqlx::query(
            r#"
            INSERT INTO platform_jobs_apalis_migrations (
                version,
                description,
                success,
                checksum,
                execution_time
            )
            VALUES ($1, $2, TRUE, $3, $4)
            "#,
        )
        .bind(migration.version)
        .bind(migration.description.as_ref())
        .bind(migration.checksum.as_ref())
        .bind(started.elapsed().as_nanos() as i64)
        .execute(&mut *transaction)
        .await
        .map_err(|err| JobQueueError::ApalisPostgres(err.to_string()))?;
        transaction.commit().await.map_err(|err| {
            JobQueueError::ApalisPostgres(format!(
                "failed to commit apalis migration {}: {err}",
                migration.version
            ))
        })?;
    }

    Ok(())
}

impl JobQueue for ApalisPostgresJobQueue {
    fn enqueue<'a>(&'a self, request: JobRequest) -> BoxFuture<'a, Result<JobId, JobQueueError>> {
        Box::pin(async move {
            self.schedule_at(request, mnt_kernel_core::SystemClock.now())
                .await
        })
    }

    fn schedule_at<'a>(
        &'a self,
        request: JobRequest,
        scheduled_at: Timestamp,
    ) -> BoxFuture<'a, Result<JobId, JobQueueError>> {
        Box::pin(async move {
            let run_at = unix_timestamp_seconds(scheduled_at)?;
            let idempotency_key = request.idempotency_key.as_str().to_owned();
            let task = apalis_postgres::PgTask::<PlatformJob>::builder(request.job)
                .run_at_timestamp(run_at)
                .with_idempotency_key(&idempotency_key)
                .max_attempts(5)
                .build();

            let mut backend =
                PostgresStorage::<PlatformJob>::new_with_config(&self.pool, &self.config);
            match backend.push_task(task).await {
                Ok(()) => Ok(JobId(idempotency_key)),
                Err(err) if is_unique_idempotency_conflict(&err.to_string()) => {
                    Ok(JobId(idempotency_key))
                }
                Err(err) => Err(JobQueueError::ApalisTaskSink(err.to_string())),
            }
        })
    }
}

pub fn schedule_after(clock: &dyn Clock, delay: StdDuration) -> Result<Timestamp, JobQueueError> {
    let delay =
        time::Duration::try_from(delay).map_err(|_| JobQueueError::ScheduleDelayTooLarge)?;
    clock
        .now()
        .checked_add(delay)
        .ok_or(JobQueueError::ScheduleDelayTooLarge)
}

#[derive(Clone, Copy)]
pub struct SkewedClock<'a> {
    inner: &'a dyn Clock,
    offset: time::Duration,
}

impl<'a> SkewedClock<'a> {
    #[must_use]
    pub fn new(inner: &'a dyn Clock, offset: time::Duration) -> Self {
        Self { inner, offset }
    }
}

impl Clock for SkewedClock<'_> {
    fn now(&self) -> Timestamp {
        self.inner.now() + self.offset
    }
}

fn unix_timestamp_seconds(value: Timestamp) -> Result<u64, JobQueueError> {
    let timestamp = value.unix_timestamp();
    u64::try_from(timestamp).map_err(|_| JobQueueError::ScheduledBeforeUnixEpoch)
}

fn is_unique_idempotency_conflict(message: &str) -> bool {
    message.contains("idx_jobs_idempotency_key")
}

#[cfg(test)]
mod tests {
    use super::*;
    use mnt_kernel_core::FixedClock;

    #[test]
    fn schedule_after_uses_injected_clock() {
        let base = time::macros::datetime!(2026-06-12 09:00:00 UTC);
        let fixed = FixedClock(base);
        let skewed = SkewedClock::new(&fixed, time::Duration::seconds(7));

        let scheduled = schedule_after(&skewed, StdDuration::from_secs(3)).unwrap();

        assert_eq!(scheduled, time::macros::datetime!(2026-06-12 09:00:10 UTC));
    }

    #[test]
    fn rejects_empty_idempotency_key() {
        let result = JobRequest::escalation_timer(
            "scenario",
            "timer-1",
            time::macros::datetime!(2026-06-12 09:00:00 UTC),
            "   ",
        );

        assert!(matches!(result, Err(JobQueueError::InvalidIdempotencyKey)));
    }

    #[test]
    fn unique_conflict_detection_only_accepts_idempotency_constraint() {
        assert!(is_unique_idempotency_conflict(
            "duplicate key value violates unique constraint \"idx_jobs_idempotency_key\""
        ));
        assert!(!is_unique_idempotency_conflict(
            "duplicate key value violates unique constraint \"unique_job_id\""
        ));
        assert!(!is_unique_idempotency_conflict(
            "duplicate key value violates unique constraint"
        ));
    }
}
