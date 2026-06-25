//! `mnt-platform-jobs` - job queue port plus the apalis-postgres adapter.
//!
//! ADR-0011 keeps apalis isolated behind [`JobQueue`]. The adapter owns apalis'
//! timestamped migrations and `apalis.*` schema; numbered project migrations
//! remain in `mnt-platform-db`.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::{future::Future, pin::Pin, sync::Arc, time::Duration as StdDuration};

use apalis::prelude::{BoxDynError, Data, TaskSink, WorkerBuilder, WorkerContext};
use apalis_postgres::{Config, PgPool as ApalisPgPool, PostgresStorage};
use apalis_sql::ext::TaskBuilderExt as _;
use apalis_sqlx::{Connection as _, Executor as _, Row as _};
use mnt_kernel_core::{Clock, EvidenceId, OrgId, P1DispatchId, Timestamp};
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
    /// Build a [`JobId`] from a key string. Used by alternate [`JobQueue`]
    /// implementations (e.g. test stubs) that don't go through apalis.
    #[must_use]
    pub fn from_key(key: impl Into<String>) -> Self {
        Self(key.into())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PlatformJob {
    EscalationTimer(EscalationTimerJob),
    DispatchAcceptWindowExpired(DispatchTimerJob),
    DispatchAlimtalkNoAck(DispatchTimerJob),
    DispatchManualCallRequired(DispatchTimerJob),
    /// Transcode/optimize a staged evidence original into the final 1080p/
    /// recompressed deliverable. Carries the owning tenant so the worker arms
    /// `app.current_org` to the right org for its RLS-gated reads/writes.
    EvidenceTranscode(EvidenceTranscodeJob),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceTranscodeJob {
    /// The tenant that owns the evidence row. Carried on the payload so the
    /// background worker arms `app.current_org` to the RIGHT tenant for its
    /// RLS-gated staging read + status write — never a hardcoded tenant.
    pub org_id: OrgId,
    pub evidence_id: EvidenceId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EscalationTimerJob {
    pub scenario_id: String,
    pub timer_id: String,
    pub scheduled_for: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DispatchTimerJob {
    pub dispatch_id: P1DispatchId,
    /// The tenant that owns the dispatch. Carried on the payload so the
    /// background worker can arm `app.current_org` to the RIGHT tenant for its
    /// RLS-gated reads/writes — never a hardcoded bootstrap tenant. Defaults to
    /// KNL on a legacy payload that predates this field, so jobs enqueued before
    /// the multi-tenant rollout still process under the original single tenant.
    #[serde(default = "OrgId::knl")]
    pub org_id: OrgId,
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

    pub fn dispatch_accept_window_expired(
        dispatch_id: P1DispatchId,
        org_id: OrgId,
        scheduled_for: Timestamp,
    ) -> Result<Self, JobQueueError> {
        Ok(Self {
            job: PlatformJob::DispatchAcceptWindowExpired(DispatchTimerJob {
                dispatch_id,
                org_id,
                scheduled_for,
            }),
            idempotency_key: IdempotencyKey::new(format!(
                "p1-dispatch:{}:accept-window",
                dispatch_id
            ))?,
        })
    }

    pub fn dispatch_alimtalk_no_ack(
        dispatch_id: P1DispatchId,
        org_id: OrgId,
        scheduled_for: Timestamp,
    ) -> Result<Self, JobQueueError> {
        Ok(Self {
            job: PlatformJob::DispatchAlimtalkNoAck(DispatchTimerJob {
                dispatch_id,
                org_id,
                scheduled_for,
            }),
            idempotency_key: IdempotencyKey::new(format!(
                "p1-dispatch:{}:alimtalk-no-ack",
                dispatch_id
            ))?,
        })
    }

    pub fn dispatch_manual_call_required(
        dispatch_id: P1DispatchId,
        org_id: OrgId,
        scheduled_for: Timestamp,
    ) -> Result<Self, JobQueueError> {
        Ok(Self {
            job: PlatformJob::DispatchManualCallRequired(DispatchTimerJob {
                dispatch_id,
                org_id,
                scheduled_for,
            }),
            idempotency_key: IdempotencyKey::new(format!(
                "p1-dispatch:{}:manual-call-required",
                dispatch_id
            ))?,
        })
    }

    /// Enqueue a media transcode/optimize job for a staged evidence original.
    /// Idempotency keys on the evidence id, so a re-issued presign for the same
    /// row coalesces to a single transcode.
    pub fn evidence_transcode(
        org_id: OrgId,
        evidence_id: EvidenceId,
    ) -> Result<Self, JobQueueError> {
        Ok(Self {
            job: PlatformJob::EvidenceTranscode(EvidenceTranscodeJob {
                org_id,
                evidence_id,
            }),
            idempotency_key: IdempotencyKey::new(format!("evidence-transcode:{evidence_id}"))?,
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

pub trait PlatformJobHandler: Send + Sync + 'static {
    fn handle<'a>(&'a self, job: PlatformJob) -> BoxFuture<'a, Result<(), JobQueueError>>;
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
            CREATE SCHEMA IF NOT EXISTS apalis;

            CREATE TABLE IF NOT EXISTS apalis.platform_jobs_apalis_migrations (
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
    copy_legacy_apalis_migration_ledger(conn).await?;
    if adopt_existing_apalis_schema_if_needed(conn, migrations.iter()).await? {
        return Ok(());
    }

    for migration in migrations.iter() {
        if migration.migration_type.is_down_migration() {
            continue;
        }

        let applied = apalis_sqlx::query(
            r#"
            SELECT checksum, success
            FROM apalis.platform_jobs_apalis_migrations
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
        let sql = normalized_apalis_migration_sql(migration);
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
            INSERT INTO apalis.platform_jobs_apalis_migrations (
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

async fn copy_legacy_apalis_migration_ledger(
    conn: &mut apalis_sqlx::pool::PoolConnection<apalis_sqlx::Postgres>,
) -> Result<(), JobQueueError> {
    (&mut **conn)
        .execute(
            r#"
            DO $$
            BEGIN
                IF to_regclass('public.platform_jobs_apalis_migrations') IS NOT NULL THEN
                    EXECUTE '
                        INSERT INTO apalis.platform_jobs_apalis_migrations (
                            version,
                            description,
                            installed_on,
                            success,
                            checksum,
                            execution_time
                        )
                        SELECT
                            version,
                            description,
                            installed_on,
                            success,
                            checksum,
                            execution_time
                        FROM public.platform_jobs_apalis_migrations
                        ON CONFLICT (version) DO NOTHING
                    ';
                END IF;
            END
            $$;
            "#,
        )
        .await
        .map_err(|err| JobQueueError::ApalisPostgres(err.to_string()))?;
    Ok(())
}

async fn adopt_existing_apalis_schema_if_needed<'a>(
    conn: &mut apalis_sqlx::pool::PoolConnection<apalis_sqlx::Postgres>,
    migrations: impl Iterator<Item = &'a apalis_sqlx::migrate::Migration>,
) -> Result<bool, JobQueueError> {
    let applied_count = apalis_sqlx::query(
        r#"
        SELECT COUNT(*) AS count
        FROM apalis.platform_jobs_apalis_migrations
        WHERE success = TRUE
        "#,
    )
    .fetch_one(&mut **conn)
    .await
    .map_err(|err| JobQueueError::ApalisPostgres(err.to_string()))?
    .try_get::<i64, _>("count")
    .map_err(|err| JobQueueError::ApalisPostgres(err.to_string()))?;

    if applied_count > 0 || !existing_apalis_schema_is_current(conn).await? {
        return Ok(false);
    }

    let mut transaction = conn
        .begin()
        .await
        .map_err(|err| JobQueueError::ApalisPostgres(err.to_string()))?;
    for migration in migrations {
        if migration.migration_type.is_down_migration() {
            continue;
        }
        apalis_sqlx::query(
            r#"
            INSERT INTO apalis.platform_jobs_apalis_migrations (
                version,
                description,
                success,
                checksum,
                execution_time
            )
            VALUES ($1, $2, TRUE, $3, 0)
            ON CONFLICT (version) DO NOTHING
            "#,
        )
        .bind(migration.version)
        .bind(migration.description.as_ref())
        .bind(migration.checksum.as_ref())
        .execute(&mut *transaction)
        .await
        .map_err(|err| JobQueueError::ApalisPostgres(err.to_string()))?;
    }
    transaction.commit().await.map_err(|err| {
        JobQueueError::ApalisPostgres(format!("failed to adopt apalis migrations: {err}"))
    })?;
    Ok(true)
}

async fn existing_apalis_schema_is_current(
    conn: &mut apalis_sqlx::pool::PoolConnection<apalis_sqlx::Postgres>,
) -> Result<bool, JobQueueError> {
    let row = apalis_sqlx::query(
        r#"
        SELECT
            to_regclass('apalis.jobs') IS NOT NULL AS has_jobs,
            to_regclass('apalis.workers') IS NOT NULL AS has_workers,
            to_regclass('apalis.idx_jobs_idempotency_key') IS NOT NULL AS has_idempotency_index,
            (
                SELECT COUNT(*)
                FROM information_schema.columns
                WHERE table_schema = 'apalis'
                    AND table_name = 'jobs'
                    AND (
                        (column_name = 'job' AND data_type = 'bytea')
                        OR (column_name = 'id' AND data_type = 'text')
                        OR (column_name = 'job_type' AND data_type = 'text')
                        OR (column_name = 'status' AND data_type = 'text')
                        OR (column_name = 'attempts' AND data_type = 'integer')
                        OR (column_name = 'max_attempts' AND data_type = 'integer')
                        OR (column_name = 'run_at' AND data_type = 'timestamp with time zone')
                        OR (column_name = 'last_result' AND data_type = 'jsonb')
                        OR (column_name = 'lock_at' AND data_type = 'timestamp with time zone')
                        OR (column_name = 'lock_by' AND data_type = 'text')
                        OR (column_name = 'done_at' AND data_type = 'timestamp with time zone')
                        OR (column_name = 'priority' AND data_type = 'integer')
                        OR (column_name = 'metadata' AND data_type = 'jsonb')
                        OR (column_name = 'idempotency_key' AND data_type = 'text')
                    )
            ) AS current_job_columns,
            (
                SELECT COUNT(*)
                FROM information_schema.columns
                WHERE table_schema = 'apalis'
                    AND table_name = 'workers'
                    AND (
                        (column_name = 'id' AND data_type = 'text')
                        OR (column_name = 'worker_type' AND data_type = 'text')
                        OR (column_name = 'storage_name' AND data_type = 'text')
                        OR (column_name = 'layers' AND data_type = 'text')
                        OR (column_name = 'last_seen' AND data_type = 'timestamp with time zone')
                        OR (column_name = 'started_at' AND data_type = 'timestamp with time zone')
                    )
            ) AS current_worker_columns
        "#,
    )
    .fetch_one(&mut **conn)
    .await
    .map_err(|err| JobQueueError::ApalisPostgres(err.to_string()))?;

    let has_jobs = row
        .try_get::<bool, _>("has_jobs")
        .map_err(|err| JobQueueError::ApalisPostgres(err.to_string()))?;
    let has_workers = row
        .try_get::<bool, _>("has_workers")
        .map_err(|err| JobQueueError::ApalisPostgres(err.to_string()))?;
    let has_idempotency_index = row
        .try_get::<bool, _>("has_idempotency_index")
        .map_err(|err| JobQueueError::ApalisPostgres(err.to_string()))?;
    let current_job_columns = row
        .try_get::<i64, _>("current_job_columns")
        .map_err(|err| JobQueueError::ApalisPostgres(err.to_string()))?;
    let current_worker_columns = row
        .try_get::<i64, _>("current_worker_columns")
        .map_err(|err| JobQueueError::ApalisPostgres(err.to_string()))?;

    Ok(has_jobs
        && has_workers
        && has_idempotency_index
        && current_job_columns == 14
        && current_worker_columns == 6)
}

fn normalized_apalis_migration_sql(migration: &apalis_sqlx::migrate::Migration) -> String {
    let mut sql = migration.sql.replace(
        "CREATE SCHEMA apalis;",
        "CREATE SCHEMA IF NOT EXISTS apalis;",
    );
    if migration.version == 20_220_530_084_123 {
        sql = sql.replace(
            "CREATE FUNCTION apalis.notify_new_jobs() returns trigger",
            "CREATE OR REPLACE FUNCTION apalis.notify_new_jobs() returns trigger",
        );
        sql = sql.replace(
            "CREATE TRIGGER notify_workers after insert on apalis.jobs",
            "DROP TRIGGER IF EXISTS notify_workers ON apalis.jobs;\n\n        CREATE TRIGGER notify_workers after insert on apalis.jobs",
        );
    }
    sql
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

pub async fn run_apalis_worker_until_shutdown<H, F>(
    database_url: &str,
    queue_name: &str,
    worker_name: impl Into<String>,
    handler: H,
    shutdown: F,
) -> Result<(), JobQueueError>
where
    H: PlatformJobHandler,
    F: Future<Output = ()> + Send,
{
    let pool = ApalisPgPool::connect(database_url)
        .await
        .map_err(|err| JobQueueError::ApalisPostgres(err.to_string()))?;
    setup_apalis_schema(&pool).await?;
    let backend = PostgresStorage::<PlatformJob>::new_with_config(&pool, &Config::new(queue_name));
    let worker = WorkerBuilder::new(worker_name.into())
        .backend(backend)
        .data(Arc::new(handler))
        .build(handle_queued_platform_job::<H>);

    tokio::select! {
        result = worker.run() => result.map_err(|err| JobQueueError::Worker(err.to_string())),
        () = shutdown => Ok(()),
    }
}

async fn handle_queued_platform_job<H>(
    job: PlatformJob,
    handler: Data<Arc<H>>,
    _worker: WorkerContext,
) -> Result<(), BoxDynError>
where
    H: PlatformJobHandler,
{
    handler
        .handle(job)
        .await
        .map_err(|err| Box::new(err) as BoxDynError)
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

    #[test]
    fn manual_call_required_job_uses_dispatch_scoped_idempotency_key() {
        let dispatch_id = P1DispatchId::new();
        let scheduled_for = time::macros::datetime!(2026-06-12 09:10:00 UTC);

        let org_id = OrgId::knl();
        let request = JobRequest::dispatch_manual_call_required(dispatch_id, org_id, scheduled_for)
            .expect("manual-call dispatch job request should be valid");

        assert_eq!(
            request.idempotency_key.as_str(),
            format!("p1-dispatch:{dispatch_id}:manual-call-required")
        );
        assert_eq!(
            request.job,
            PlatformJob::DispatchManualCallRequired(DispatchTimerJob {
                dispatch_id,
                org_id,
                scheduled_for,
            })
        );
    }
}
