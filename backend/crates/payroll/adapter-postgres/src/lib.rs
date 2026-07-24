//! Postgres adapter for the payroll draft-run staging tables (migration
//! 0074: `payroll_draft_runs`, `payroll_draft_lines`).
//!
//! Its existing read APIs expose *pre-calculation* readiness/staging data —
//! `payroll_draft_lines` stores work-day/hour counts and `*_source_present`
//! booleans, never a computed won amount. The command seam below advances the
//! existing run status only after an exact attendance close, payroll lock, and
//! zero unresolved attendance exceptions. It still never manufactures a pay
//! amount or invokes a payout provider. The real per-employee deduction math
//! lives in `mnt_payroll_domain::build_employee_payroll_draft`; callers must
//! not present readiness data as an issued payslip.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_kernel_core::{ErrorKind, KernelError, UserId};
use mnt_payroll_domain::{
    PayrollClosePrerequisites, PayrollRunCommand, PayrollRunStatus, transition_payroll_run,
};
use mnt_platform_db::{DbError, with_org_conn};
use mnt_platform_request_context::current_org;
use serde::Serialize;
use sqlx::{PgPool, Postgres, Row, Transaction};
use time::{Date, OffsetDateTime};
use uuid::Uuid;

const DEFAULT_LIMIT: i64 = 100;
const MAX_LIMIT: i64 = 500;

#[derive(Debug, thiserror::Error)]
pub enum PgPayrollError {
    #[error(transparent)]
    Db(#[from] DbError),

    #[error(transparent)]
    Domain(#[from] KernelError),
}

impl PgPayrollError {
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::Domain(err) => err.kind,
            Self::Db(DbError::Sqlx(sqlx::Error::RowNotFound)) => ErrorKind::NotFound,
            Self::Db(_) => ErrorKind::Internal,
        }
    }
}

impl From<sqlx::Error> for PgPayrollError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(DbError::Sqlx(value))
    }
}

impl From<PgPayrollError> for KernelError {
    fn from(value: PgPayrollError) -> Self {
        match value {
            PgPayrollError::Domain(err) => err,
            PgPayrollError::Db(err) => KernelError::internal(err.to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PayrollRunSummary {
    pub id: Uuid,
    pub period_start: Date,
    pub period_end: Date,
    pub source_label: String,
    pub status: String,
    pub calculation_enabled: bool,
    pub created_by: Option<Uuid>,
    pub approved_by: Option<Uuid>,
    pub approved_at: Option<OffsetDateTime>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Clone, Serialize)]
pub struct PayrollRunPage {
    pub items: Vec<PayrollRunSummary>,
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PayrollRunDetail {
    pub run: PayrollRunSummary,
    pub legal_basis: serde_json::Value,
    pub source_summary: serde_json::Value,
    pub lines: Vec<PayrollLineSummary>,
    pub lines_total: i64,
    pub lines_limit: i64,
    pub lines_offset: i64,
}

/// One employee's readiness/staging row for a run. Deliberately has no pay
/// amount fields — the underlying table doesn't store any (see module docs).
#[derive(Debug, Clone, Serialize)]
pub struct PayrollLineSummary {
    pub id: Uuid,
    pub employee_id: Option<Uuid>,
    pub employee_display_name: String,
    pub employee_company: String,
    pub work_days: Option<f64>,
    pub regular_hours: Option<f64>,
    pub overtime_hours: Option<f64>,
    pub night_hours: Option<f64>,
    pub holiday_hours: Option<f64>,
    pub leave_used: Option<f64>,
    pub leave_remaining: Option<f64>,
    pub gross_pay_source_present: bool,
    pub net_pay_source_present: bool,
    pub nts_tax_row_status: String,
    pub calculation_status: String,
    pub blockers: serde_json::Value,
}

/// A caller's own draft-line rows across runs (self-service). Trimmed of the
/// admin-only source-import bookkeeping columns.
#[derive(Debug, Clone, Serialize)]
pub struct MyPayrollLine {
    pub run_id: Uuid,
    pub period_start: Date,
    pub period_end: Date,
    pub run_status: String,
    pub calculation_status: String,
    pub work_days: Option<f64>,
    pub regular_hours: Option<f64>,
    pub overtime_hours: Option<f64>,
    pub night_hours: Option<f64>,
    pub holiday_hours: Option<f64>,
    pub leave_used: Option<f64>,
    pub leave_remaining: Option<f64>,
    pub gross_pay_source_present: bool,
    pub net_pay_source_present: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct MyPayrollLinePage {
    pub items: Vec<MyPayrollLine>,
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
}

/// The persisted result of a close-to-payslip lifecycle command.
///
/// `idempotent` confirms a retry observed the already-requested state and did
/// not create another approval or issuance transition. It does not claim that
/// an external payment rail has transferred funds.
#[derive(Debug, Clone, Serialize)]
pub struct PayrollRunLifecycleResult {
    pub status: String,
    pub idempotent: bool,
}

#[derive(Clone)]
pub struct PgPayrollStore {
    pool: PgPool,
}

impl std::fmt::Debug for PgPayrollStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PgPayrollStore").finish_non_exhaustive()
    }
}

impl PgPayrollStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Org-scoped page of payroll draft runs, newest period first.
    ///
    /// This opens its own transaction. A caller that must combine the read
    /// with an audited write in one atomic transaction (the REST layer's
    /// "others' reads are audited" requirement) should use
    /// [`list_runs_in_tx`] against an already-armed `tx` instead — e.g.
    /// inside `mnt_platform_db::with_audits`.
    pub async fn list_runs(
        &self,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<PayrollRunPage, PgPayrollError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn::<_, _, PgPayrollError>(&self.pool, org, move |tx| {
            Box::pin(async move { list_runs_in_tx(tx, limit, offset).await })
        })
        .await
    }

    /// One run plus a page of its per-employee draft lines. `None` if the run
    /// doesn't exist (or belongs to another org — RLS makes the two
    /// indistinguishable, deny-by-omission).
    ///
    /// Opens its own transaction; see [`Self::list_runs`] on using
    /// [`get_run_in_tx`] instead for an atomic audited read.
    pub async fn get_run(
        &self,
        run_id: Uuid,
        lines_limit: Option<i64>,
        lines_offset: Option<i64>,
    ) -> Result<Option<PayrollRunDetail>, PgPayrollError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn::<_, _, PgPayrollError>(&self.pool, org, move |tx| {
            Box::pin(async move { get_run_in_tx(tx, run_id, lines_limit, lines_offset).await })
        })
        .await
    }

    /// The employee row linked to `user_id`, or `None` if the account has no
    /// link (mirrors `hr.rs::load_optional_linked_employee_id`).
    pub async fn linked_employee_id(
        &self,
        user_id: UserId,
    ) -> Result<Option<Uuid>, PgPayrollError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn::<_, _, PgPayrollError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let employee_id: Option<Uuid> =
                    sqlx::query_scalar("SELECT employee_id FROM users WHERE id = $1")
                        .bind(*user_id.as_uuid())
                        .fetch_optional(tx.as_mut())
                        .await?
                        .flatten();
                Ok(employee_id)
            })
        })
        .await
    }

    /// Self-scoped page of the caller's own draft-line rows across runs,
    /// newest run period first. `employee_id` must already be resolved from
    /// the authenticated principal (never accepted from client input).
    pub async fn list_my_lines(
        &self,
        employee_id: Uuid,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<MyPayrollLinePage, PgPayrollError> {
        let org = current_org().map_err(KernelError::from)?;
        let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
        let offset = offset.unwrap_or(0).max(0);

        let (items, total) = with_org_conn::<_, _, PgPayrollError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let total: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM payroll_draft_lines WHERE employee_id = $1",
                )
                .bind(employee_id)
                .fetch_one(tx.as_mut())
                .await?;

                let rows = sqlx::query(
                    r#"
                    SELECT r.id AS run_id, r.period_start, r.period_end, r.status AS run_status,
                           l.calculation_status,
                           l.work_days::float8 AS work_days,
                           l.regular_hours::float8 AS regular_hours,
                           l.overtime_hours::float8 AS overtime_hours,
                           l.night_hours::float8 AS night_hours,
                           l.holiday_hours::float8 AS holiday_hours,
                           l.leave_used::float8 AS leave_used,
                           l.leave_remaining::float8 AS leave_remaining,
                           l.gross_pay_source_present, l.net_pay_source_present
                    FROM payroll_draft_lines l
                    JOIN payroll_draft_runs r ON r.id = l.run_id
                    WHERE l.employee_id = $1
                    ORDER BY r.period_start DESC, r.period_end DESC, l.id DESC
                    LIMIT $2 OFFSET $3
                    "#,
                )
                .bind(employee_id)
                .bind(limit)
                .bind(offset)
                .fetch_all(tx.as_mut())
                .await?;
                let items = rows
                    .iter()
                    .map(my_line_from_row)
                    .collect::<Result<Vec<_>, PgPayrollError>>()?;
                Ok((items, total))
            })
        })
        .await?;

        Ok(MyPayrollLinePage {
            items,
            total,
            limit,
            offset,
        })
    }

    /// Advance a staged payroll run to review only after the exact org/month
    /// attendance close, its active payroll lock, and zero open attendance
    /// exceptions are all observed under the same RLS-scoped transaction.
    pub async fn calculate_run(
        &self,
        run_id: Uuid,
    ) -> Result<PayrollRunLifecycleResult, PgPayrollError> {
        self.advance_run(run_id, PayrollRunCommand::Calculate, None)
            .await
    }

    /// Approve a reviewed payroll run. The run's creator may not approve it;
    /// a missing creator is also rejected rather than silently weakening
    /// separation of duties.
    pub async fn approve_run(
        &self,
        run_id: Uuid,
        approver: UserId,
    ) -> Result<PayrollRunLifecycleResult, PgPayrollError> {
        self.advance_run(
            run_id,
            PayrollRunCommand::Approve {
                approver_is_creator: false,
            },
            Some(approver),
        )
        .await
    }

    /// Record issuance after approval. This updates the existing regulated run
    /// lifecycle only; payout-provider execution remains a separate adapter.
    pub async fn mark_run_issued(
        &self,
        run_id: Uuid,
    ) -> Result<PayrollRunLifecycleResult, PgPayrollError> {
        self.advance_run(run_id, PayrollRunCommand::MarkIssued, None)
            .await
    }

    async fn advance_run(
        &self,
        run_id: Uuid,
        command: PayrollRunCommand,
        actor: Option<UserId>,
    ) -> Result<PayrollRunLifecycleResult, PgPayrollError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn::<_, _, PgPayrollError>(&self.pool, org, move |tx| {
            Box::pin(async move { advance_run_in_tx(tx, run_id, command, actor).await })
        })
        .await
    }
}

/// Transaction-owned command seam for later audited REST composition. The
/// caller must use an already-armed org-scoped transaction.
pub async fn advance_run_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
    command: PayrollRunCommand,
    actor: Option<UserId>,
) -> Result<PayrollRunLifecycleResult, PgPayrollError> {
    let Some(row) = sqlx::query(
        "SELECT period_start, period_end, status, created_by \
         FROM payroll_draft_runs WHERE id = $1 FOR UPDATE",
    )
    .bind(run_id)
    .fetch_optional(tx.as_mut())
    .await?
    else {
        return Err(KernelError::not_found("payroll run not found").into());
    };

    let period_start: Date = row.try_get("period_start")?;
    let period_end: Date = row.try_get("period_end")?;
    let status = PayrollRunStatus::parse(row.try_get::<String, _>("status")?.as_str())?;
    let created_by: Option<Uuid> = row.try_get("created_by")?;

    let approval_actor_id = actor.map(|user| *user.as_uuid());
    let command = match command {
        PayrollRunCommand::Approve { .. } => {
            let approver = approval_actor_id.ok_or_else(|| {
                KernelError::validation("payroll approval requires an authenticated approver")
            })?;
            let creator = created_by.ok_or_else(|| {
                KernelError::conflict("payroll approval requires a recorded run creator")
            })?;
            PayrollRunCommand::Approve {
                approver_is_creator: creator == approver,
            }
        }
        other => other,
    };

    let prerequisites = close_prerequisites_in_tx(tx, period_start, period_end).await?;
    let transition = transition_payroll_run(status, command, prerequisites)?;
    if transition.idempotent {
        return Ok(PayrollRunLifecycleResult {
            status: transition.status.as_str().to_owned(),
            idempotent: true,
        });
    }

    match command {
        PayrollRunCommand::Calculate => {
            sqlx::query(
                "UPDATE payroll_draft_runs \
                 SET status = $2, calculation_enabled = TRUE, updated_at = now() WHERE id = $1",
            )
            .bind(run_id)
            .bind(transition.status.as_str())
            .execute(tx.as_mut())
            .await?;
        }
        PayrollRunCommand::Approve { .. } => {
            let approver = approval_actor_id.ok_or_else(|| {
                KernelError::internal("approved payroll transition lost its approver")
            })?;
            sqlx::query(
                "UPDATE payroll_draft_runs \
                 SET status = $2, approved_by = $3, approved_at = now(), updated_at = now() WHERE id = $1",
            )
            .bind(run_id)
            .bind(transition.status.as_str())
            .bind(approver)
            .execute(tx.as_mut())
            .await?;
        }
        PayrollRunCommand::MarkIssued => {
            sqlx::query(
                "UPDATE payroll_draft_runs SET status = $2, updated_at = now() WHERE id = $1",
            )
            .bind(run_id)
            .bind(transition.status.as_str())
            .execute(tx.as_mut())
            .await?;
        }
    }

    Ok(PayrollRunLifecycleResult {
        status: transition.status.as_str().to_owned(),
        idempotent: false,
    })
}

async fn close_prerequisites_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    period_start: Date,
    period_end: Date,
) -> Result<PayrollClosePrerequisites, PgPayrollError> {
    let org_month_close_present: bool = sqlx::query_scalar(
        "SELECT EXISTS( \
         SELECT 1 FROM attendance_month_closes \
         WHERE month = $1 AND branch_id IS NULL)",
    )
    .bind(period_start)
    .fetch_one(tx.as_mut())
    .await?;
    let active_exact_payroll_lock_present: bool = sqlx::query_scalar(
        "SELECT EXISTS( \
         SELECT 1 FROM period_locks \
         WHERE domain = 'payroll' AND period_start = $1 AND period_end = $2 \
           AND unlocked_at IS NULL)",
    )
    .bind(period_start)
    .bind(period_end)
    .fetch_one(tx.as_mut())
    .await?;
    let unresolved_attendance_exception_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM attendance_exceptions \
         WHERE status = 'OPEN' AND work_date >= $1 AND work_date <= $2",
    )
    .bind(period_start)
    .bind(period_end)
    .fetch_one(tx.as_mut())
    .await?;
    let unresolved_attendance_exception_count =
        u64::try_from(unresolved_attendance_exception_count)
            .map_err(|_| KernelError::internal("attendance exception count was negative"))?;
    Ok(PayrollClosePrerequisites {
        period_start,
        period_end,
        org_month_close_present,
        active_exact_payroll_lock_present,
        unresolved_attendance_exception_count,
    })
}

/// Query logic behind [`PgPayrollStore::list_runs`], factored out so a
/// caller that must combine this read with an audited write in one
/// transaction (e.g. `mnt_platform_db::with_audits`) can run it against an
/// already-armed `tx` instead of opening a second, non-atomic transaction.
pub async fn list_runs_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<PayrollRunPage, PgPayrollError> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = offset.unwrap_or(0).max(0);

    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payroll_draft_runs")
        .fetch_one(tx.as_mut())
        .await?;
    let rows = sqlx::query(
        r#"
        SELECT id, period_start, period_end, source_label, status,
               calculation_enabled, created_by, approved_by, approved_at,
               created_at, updated_at
        FROM payroll_draft_runs
        ORDER BY period_start DESC, period_end DESC, id DESC
        LIMIT $1 OFFSET $2
        "#,
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(tx.as_mut())
    .await?;
    let items = rows
        .iter()
        .map(run_summary_from_row)
        .collect::<Result<Vec<_>, PgPayrollError>>()?;

    Ok(PayrollRunPage {
        items,
        total,
        limit,
        offset,
    })
}

/// Query logic behind [`PgPayrollStore::get_run`]; see [`list_runs_in_tx`]
/// on why this takes an already-armed `tx` rather than owning its own
/// transaction.
pub async fn get_run_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
    lines_limit: Option<i64>,
    lines_offset: Option<i64>,
) -> Result<Option<PayrollRunDetail>, PgPayrollError> {
    let lines_limit = lines_limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let lines_offset = lines_offset.unwrap_or(0).max(0);

    let Some(run_row) = fetch_run_row(tx, run_id).await? else {
        return Ok(None);
    };
    let run = run_summary_from_row(&run_row)?;
    let legal_basis: serde_json::Value = run_row.try_get("legal_basis")?;
    let source_summary: serde_json::Value = run_row.try_get("source_summary")?;

    let lines_total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM payroll_draft_lines WHERE run_id = $1")
            .bind(run_id)
            .fetch_one(tx.as_mut())
            .await?;

    let line_rows = sqlx::query(
        r#"
        SELECT id, employee_id, employee_display_name, employee_company,
               work_days::float8 AS work_days,
               regular_hours::float8 AS regular_hours,
               overtime_hours::float8 AS overtime_hours,
               night_hours::float8 AS night_hours,
               holiday_hours::float8 AS holiday_hours,
               leave_used::float8 AS leave_used,
               leave_remaining::float8 AS leave_remaining,
               gross_pay_source_present, net_pay_source_present,
               nts_tax_row_status, calculation_status, blockers
        FROM payroll_draft_lines
        WHERE run_id = $1
        ORDER BY employee_company, employee_display_name, id
        LIMIT $2 OFFSET $3
        "#,
    )
    .bind(run_id)
    .bind(lines_limit)
    .bind(lines_offset)
    .fetch_all(tx.as_mut())
    .await?;
    let lines = line_rows
        .iter()
        .map(line_summary_from_row)
        .collect::<Result<Vec<_>, PgPayrollError>>()?;

    Ok(Some(PayrollRunDetail {
        run,
        legal_basis,
        source_summary,
        lines,
        lines_total,
        lines_limit,
        lines_offset,
    }))
}

async fn fetch_run_row(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
) -> Result<Option<sqlx::postgres::PgRow>, PgPayrollError> {
    Ok(sqlx::query(
        r#"
        SELECT id, period_start, period_end, source_label, status,
               calculation_enabled, created_by, approved_by, approved_at,
               created_at, updated_at, legal_basis, source_summary
        FROM payroll_draft_runs
        WHERE id = $1
        "#,
    )
    .bind(run_id)
    .fetch_optional(tx.as_mut())
    .await?)
}

fn run_summary_from_row(row: &sqlx::postgres::PgRow) -> Result<PayrollRunSummary, PgPayrollError> {
    Ok(PayrollRunSummary {
        id: row.try_get("id")?,
        period_start: row.try_get("period_start")?,
        period_end: row.try_get("period_end")?,
        source_label: row.try_get("source_label")?,
        status: row.try_get("status")?,
        calculation_enabled: row.try_get("calculation_enabled")?,
        created_by: row.try_get("created_by")?,
        approved_by: row.try_get("approved_by")?,
        approved_at: row.try_get("approved_at")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn line_summary_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<PayrollLineSummary, PgPayrollError> {
    Ok(PayrollLineSummary {
        id: row.try_get("id")?,
        employee_id: row.try_get("employee_id")?,
        employee_display_name: row.try_get("employee_display_name")?,
        employee_company: row.try_get("employee_company")?,
        work_days: row.try_get("work_days")?,
        regular_hours: row.try_get("regular_hours")?,
        overtime_hours: row.try_get("overtime_hours")?,
        night_hours: row.try_get("night_hours")?,
        holiday_hours: row.try_get("holiday_hours")?,
        leave_used: row.try_get("leave_used")?,
        leave_remaining: row.try_get("leave_remaining")?,
        gross_pay_source_present: row.try_get("gross_pay_source_present")?,
        net_pay_source_present: row.try_get("net_pay_source_present")?,
        nts_tax_row_status: row.try_get("nts_tax_row_status")?,
        calculation_status: row.try_get("calculation_status")?,
        blockers: row.try_get("blockers")?,
    })
}

fn my_line_from_row(row: &sqlx::postgres::PgRow) -> Result<MyPayrollLine, PgPayrollError> {
    Ok(MyPayrollLine {
        run_id: row.try_get("run_id")?,
        period_start: row.try_get("period_start")?,
        period_end: row.try_get("period_end")?,
        run_status: row.try_get("run_status")?,
        calculation_status: row.try_get("calculation_status")?,
        work_days: row.try_get("work_days")?,
        regular_hours: row.try_get("regular_hours")?,
        overtime_hours: row.try_get("overtime_hours")?,
        night_hours: row.try_get("night_hours")?,
        holiday_hours: row.try_get("holiday_hours")?,
        leave_used: row.try_get("leave_used")?,
        leave_remaining: row.try_get("leave_remaining")?,
        gross_pay_source_present: row.try_get("gross_pay_source_present")?,
        net_pay_source_present: row.try_get("net_pay_source_present")?,
    })
}
