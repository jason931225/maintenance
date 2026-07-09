//! Period locks (freeze windows) — the enforcement half of month-close/마감.
//!
//! A `period_locks` row with `unlocked_at IS NULL` freezes writes whose
//! business date falls inside `[period_start, period_end]` for one domain
//! (`payroll` or `accounting`). Every mutation that stamps a date must call
//! [`assert_period_open`] (single date) or [`assert_period_open_range`]
//! (period-shaped writes) inside its already-armed transaction; the check is
//! RLS-scoped, so it only ever sees the caller's own tenant locks.
//!
//! The guard fails closed with `KernelError::conflict` (HTTP 409 through every
//! domain error mapper), naming the domain and the locked window so the caller
//! can render an actionable "period closed" error.

use mnt_kernel_core::KernelError;
use sqlx::{Postgres, Row, Transaction};
use time::Date;

use crate::error::DbError;

/// Business domains a period lock can freeze. Matches the `period_locks.domain`
/// CHECK constraint (migration 0107).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeriodLockDomain {
    Payroll,
    Accounting,
}

impl PeriodLockDomain {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Payroll => "payroll",
            Self::Accounting => "accounting",
        }
    }

    /// Parse a client-supplied domain string, fail-closed on anything unknown.
    pub fn parse(value: &str) -> Result<Self, KernelError> {
        match value {
            "payroll" => Ok(Self::Payroll),
            "accounting" => Ok(Self::Accounting),
            other => Err(KernelError::validation(format!(
                "unknown period lock domain '{other}' (expected payroll|accounting)"
            ))),
        }
    }
}

impl std::fmt::Display for PeriodLockDomain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Refuse the mutation when `date` falls inside an active lock for `domain`.
///
/// Runs inside the caller's armed transaction (`with_audit`/`with_audits`/
/// `with_org_conn`), so RLS confines the lookup to the current tenant and the
/// refusal rolls the whole mutation back.
pub async fn assert_period_open(
    tx: &mut Transaction<'_, Postgres>,
    domain: PeriodLockDomain,
    date: Date,
) -> Result<(), KernelError> {
    assert_period_open_range(tx, domain, date, date).await
}

/// Refuse the mutation when `[start, end]` overlaps an active lock for `domain`.
pub async fn assert_period_open_range(
    tx: &mut Transaction<'_, Postgres>,
    domain: PeriodLockDomain,
    start: Date,
    end: Date,
) -> Result<(), KernelError> {
    let lock = sqlx::query(
        "SELECT period_start, period_end FROM period_locks \
         WHERE domain = $1 AND unlocked_at IS NULL \
           AND period_start <= $3 AND period_end >= $2 \
         ORDER BY locked_at DESC LIMIT 1",
    )
    .bind(domain.as_str())
    .bind(start)
    .bind(end)
    .fetch_optional(tx.as_mut())
    .await
    .map_err(|e| kernel_internal(DbError::Sqlx(e)))?;

    if let Some(row) = lock {
        let period_start: Date = row.try_get("period_start").map_err(sqlx_internal)?;
        let period_end: Date = row.try_get("period_end").map_err(sqlx_internal)?;
        return Err(KernelError::conflict(format!(
            "{domain} period {period_start}..{period_end} is locked; write dated {start}..{end} refused"
        )));
    }
    Ok(())
}

fn kernel_internal(err: DbError) -> KernelError {
    KernelError::internal(format!("period lock check failed: {err}"))
}

fn sqlx_internal(err: sqlx::Error) -> KernelError {
    kernel_internal(DbError::Sqlx(err))
}
