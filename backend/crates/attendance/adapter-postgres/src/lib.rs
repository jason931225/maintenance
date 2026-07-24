//! Tenant-scoped persistence for attendance.  All SQL is bind-parameterized;
//! reads use RLS-bound connections and mutations write the domain audit event
//! in the same transaction as their state transition.
#![cfg_attr(test, allow(clippy::unwrap_used))]

use std::collections::BTreeMap;

use mnt_attendance_application::{
    self as app, AcknowledgeWeek52, AmendClose, AssignSubstitute, CallerScope, CancelSubstitution,
    CloseChecks, CloseMonth, ListSubstitutions, RaiseException, ResolveException, Week52Input,
};
use mnt_attendance_domain::{AttendanceDateRange, ExceptionKind, HistoricalAbsence};
use mnt_kernel_core::{AuditAction, AuditEvent, BranchId, KernelError, OrgId, TraceContext};
use mnt_platform_db::{DbError, issue_code, with_audits, with_org_conn};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction};
use time::{Date, Duration, OffsetDateTime};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum AttendanceStoreError {
    #[error(transparent)]
    Application(#[from] app::AttendanceApplicationError),
    #[error(transparent)]
    Database(#[from] DbError),
    #[error(transparent)]
    Sql(#[from] sqlx::Error),
    #[error("not found")]
    NotFound,
    #[error("conflict")]
    Conflict,
    #[error("close is blocked")]
    CloseBlocked,
}

#[derive(Debug, Clone)]
pub struct PgAttendanceStore {
    pool: PgPool,
}
impl PgAttendanceStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn list_substitutions(
        &self,
        caller: &CallerScope,
        query: ListSubstitutions,
    ) -> Result<(Vec<Value>, i64), AttendanceStoreError> {
        app::ensure_scope(caller, query.branch_id)?;
        let org = OrgId::from_uuid(caller.org_id);
        with_org_conn::<_, _, AttendanceStoreError>(&self.pool, org, move |tx| Box::pin(async move {
            let rows = sqlx::query("SELECT s.id,s.site,s.branch_id,s.role,s.cover_date,s.from_minutes,s.to_minutes,s.covered_employee_id,cov.name AS covered_name,s.reason_kind,s.reason_detail,s.worker_employee_id,s.worker_name,s.worker_type,s.worker_rate,s.status,s.exception_id,s.created_at FROM attendance_substitutions s JOIN employees cov ON cov.id=s.covered_employee_id AND cov.org_id=s.org_id WHERE s.cover_date >= $1 AND s.cover_date < $2 AND ($3::uuid IS NULL OR s.branch_id=$3) ORDER BY s.cover_date,s.from_minutes,s.created_at LIMIT $4 OFFSET $5")
                .bind(query.range.from).bind(query.range.to_exclusive).bind(query.branch_id).bind(query.limit).bind(query.offset).fetch_all(tx.as_mut()).await?;
            let total: i64 = sqlx::query_scalar("SELECT count(*) FROM attendance_substitutions WHERE cover_date >= $1 AND cover_date < $2 AND ($3::uuid IS NULL OR branch_id=$3)")
                .bind(query.range.from).bind(query.range.to_exclusive).bind(query.branch_id).fetch_one(tx.as_mut()).await?;
            let items = rows.iter().map(substitution_json).collect::<Result<Vec<_>, _>>()?;
            Ok((items, total))
        })).await
    }

    pub async fn list_exceptions(
        &self,
        caller: &CallerScope,
        range: AttendanceDateRange,
        branch_id: Option<Uuid>,
    ) -> Result<Vec<Value>, AttendanceStoreError> {
        app::ensure_scope(caller, branch_id)?;
        let org = OrgId::from_uuid(caller.org_id);
        with_org_conn::<_, _, AttendanceStoreError>(&self.pool, org, move |tx| Box::pin(async move {
            let rows = sqlx::query("SELECT e.id,e.code,e.kind,e.status,e.employee_id,e.branch_id,e.work_date,e.detail,e.created_at FROM attendance_exceptions e WHERE e.work_date >= $1 AND e.work_date < $2 AND ($3::uuid IS NULL OR e.branch_id=$3) ORDER BY e.work_date DESC,e.created_at DESC")
                .bind(range.from).bind(range.to_exclusive).bind(branch_id).fetch_all(tx.as_mut()).await?;
            rows.iter().map(exception_json).collect::<Result<Vec<_>, _>>()
        })).await
    }

    pub async fn raise_exception(
        &self,
        caller: &CallerScope,
        command: RaiseException,
    ) -> Result<Value, AttendanceStoreError> {
        app::ensure_scope(caller, command.branch_id)?;
        let key = app::validate_idempotency_key(&command.idempotency_key)?;
        let detail = app::validate_text(&command.detail, "detail", 2000)?;
        let org = OrgId::from_uuid(caller.org_id);
        let caller = caller.clone();
        let actor = caller.user_id;
        let id = Uuid::new_v4();
        with_audits::<_, _, AttendanceStoreError>(&self.pool, org, move |tx| Box::pin(async move {
            let request=json!({"kind":command.kind,"employeeId":command.employee_id,"branchId":command.branch_id,"workDate":command.work_date,"detail":detail,"evidence":command.evidence}); let fp=fingerprint(&request);
            idempotency_lock(tx, caller.org_id, &key).await?;
            if let Some((existing, stored))=sqlx::query_as::<_,(Uuid,String)>("SELECT id,request_fingerprint FROM attendance_exceptions WHERE idempotency_key=$1").bind(&key).fetch_optional(tx.as_mut()).await? { if stored==fp { return Ok((exception_by_id(tx,existing).await?,Vec::new())); } return Err(AttendanceStoreError::Conflict); }
            let code=issue_code(tx, OrgId::from_uuid(caller.org_id), "attendance_exception").await?;
            sqlx::query("INSERT INTO attendance_exceptions (id,org_id,code,kind,employee_id,branch_id,work_date,detail,evidence,links,idempotency_key,request_fingerprint,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'[]'::jsonb,$10,$11,$12)")
                .bind(id).bind(caller.org_id).bind(&code).bind(command.kind.as_db()).bind(command.employee_id).bind(command.branch_id).bind(command.work_date).bind(&detail).bind(command.evidence).bind(&key).bind(&fp).bind(actor).execute(tx.as_mut()).await?;
            let view=exception_by_id(tx,id).await?; let audit=event(&caller,"attendance.exception.raise","attendance_exception",id,command.branch_id,Some(json!({"code":code})))?; Ok((view,vec![audit]))
        })).await
    }

    /// Returns the branch for a tenant-scoped exception before a REST boundary
    /// authorizes a resource-id mutation. The caller maps inaccessible rows to
    /// the same 404 as absent rows to avoid branch-existence disclosure.
    pub async fn exception_branch(
        &self,
        org_id: Uuid,
        exception_id: Uuid,
    ) -> Result<Option<Option<Uuid>>, AttendanceStoreError> {
        with_org_conn::<_, _, AttendanceStoreError>(
            &self.pool,
            OrgId::from_uuid(org_id),
            move |tx| {
                Box::pin(async move {
                    sqlx::query_scalar("SELECT branch_id FROM attendance_exceptions WHERE id=$1")
                        .bind(exception_id)
                        .fetch_optional(tx.as_mut())
                        .await
                        .map_err(AttendanceStoreError::from)
                })
            },
        )
        .await
    }

    pub async fn exception_detail(
        &self,
        caller: &CallerScope,
        exception_id: Uuid,
    ) -> Result<Value, AttendanceStoreError> {
        let org = OrgId::from_uuid(caller.org_id);
        let caller = caller.clone();
        with_org_conn::<_, _, AttendanceStoreError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let row = sqlx::query("SELECT branch_id FROM attendance_exceptions WHERE id=$1")
                    .bind(exception_id)
                    .fetch_optional(tx.as_mut())
                    .await?
                    .ok_or(AttendanceStoreError::NotFound)?;
                app::ensure_scope(&caller, row.try_get("branch_id")?)?;
                exception_by_id(tx, exception_id).await
            })
        })
        .await
    }

    pub async fn resolve_exception(
        &self,
        caller: &CallerScope,
        command: ResolveException,
    ) -> Result<Value, AttendanceStoreError> {
        let reason = app::validate_text(&command.reason, "reason", 2000)?;
        let org = OrgId::from_uuid(caller.org_id);
        let caller = caller.clone();
        let actor = caller.user_id;
        with_audits::<_, _, AttendanceStoreError>(&self.pool, org, move |tx| Box::pin(async move {
            let row=sqlx::query("SELECT kind,branch_id,status FROM attendance_exceptions WHERE id=$1 FOR UPDATE").bind(command.exception_id).fetch_optional(tx.as_mut()).await?.ok_or(AttendanceStoreError::NotFound)?;
            let branch=row.try_get::<Option<Uuid>,_>("branch_id")?; app::ensure_scope(&caller,branch)?; if row.try_get::<String,_>("status")? != "OPEN" { return Err(AttendanceStoreError::Conflict); }
            let kind = ExceptionKind::parse(&row.try_get::<String,_>("kind")?).map_err(app::AttendanceApplicationError::from)?;
            command.action.validate_for(kind, command.linked_work_ref.as_deref(), command.overtime_minutes).map_err(app::AttendanceApplicationError::from)?;
            let overtime_hours = command.overtime_minutes.map(|m| format!("{:.2}", f64::from(m) / 60.0));
            let inserted=sqlx::query("INSERT INTO attendance_exception_resolutions (id,org_id,exception_id,action,reason,linked_work_ref,ot_hours,actor_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (org_id,exception_id) DO NOTHING").bind(Uuid::new_v4()).bind(caller.org_id).bind(command.exception_id).bind(command.action.as_db()).bind(&reason).bind(&command.linked_work_ref).bind(overtime_hours).bind(actor).execute(tx.as_mut()).await?;
            if inserted.rows_affected()!=1 { return Err(AttendanceStoreError::Conflict); }
            sqlx::query("UPDATE attendance_exceptions SET status='RESOLVED' WHERE id=$1 AND status='OPEN'").bind(command.exception_id).execute(tx.as_mut()).await?;
            let view=exception_by_id(tx,command.exception_id).await?; Ok((view,vec![event(&caller,"attendance.exception.resolve","attendance_exception",command.exception_id,branch,Some(json!({"action":command.action})))?]))
        })).await
    }

    pub async fn assign_substitute(
        &self,
        caller: &CallerScope,
        command: AssignSubstitute,
    ) -> Result<Value, AttendanceStoreError> {
        app::ensure_scope(caller, command.branch_id)?;
        let key = app::validate_idempotency_key(&command.idempotency_key)?;
        let mut command = command;
        command.site = app::validate_text(&command.site, "site", 120)?;
        command.role = app::validate_text(&command.role, "role", 120)?;
        command.reason_kind = app::validate_text(&command.reason_kind, "reasonKind", 60)?;
        command.reason_detail =
            app::normalize_optional_text(command.reason_detail, "reasonDetail", 500)?;
        command.worker_name = app::validate_text(&command.worker_name, "workerName", 120)?;
        command.worker_type = app::validate_text(&command.worker_type, "workerType", 60)?;
        command.worker_rate = app::normalize_optional_text(command.worker_rate, "workerRate", 60)?;
        let org = OrgId::from_uuid(caller.org_id);
        let caller = caller.clone();
        let id = Uuid::new_v4();
        with_audits::<_, _, AttendanceStoreError>(&self.pool,org,move|tx|Box::pin(async move {
            let request = substitution_fingerprint(&caller, &command); let fp=fingerprint(&request);
            idempotency_lock(tx, caller.org_id, &key).await?;
            if let Some((existing,stored))=sqlx::query_as::<_,(Uuid,String)>("SELECT id,request_fingerprint FROM attendance_substitutions WHERE idempotency_key=$1").bind(&key).fetch_optional(tx.as_mut()).await? { if stored==fp { return Ok((substitution_by_id(tx,existing).await?,Vec::new())); } return Err(AttendanceStoreError::Conflict); }
            ensure_historical_coverage(tx,command.covered_employee_id,&command.window,command.exception_id).await?;
            sqlx::query("INSERT INTO attendance_substitutions (id,org_id,site,branch_id,role,cover_date,from_minutes,to_minutes,covered_employee_id,reason_kind,reason_detail,worker_employee_id,worker_name,worker_type,worker_rate,exception_id,idempotency_key,request_fingerprint,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)")
                .bind(id).bind(caller.org_id).bind(&command.site).bind(command.branch_id).bind(&command.role).bind(command.window.cover_date).bind(command.window.from_minutes).bind(command.window.to_minutes).bind(command.covered_employee_id).bind(&command.reason_kind).bind(&command.reason_detail).bind(command.worker_employee_id).bind(&command.worker_name).bind(&command.worker_type).bind(&command.worker_rate).bind(command.exception_id).bind(&key).bind(&fp).bind(caller.user_id).execute(tx.as_mut()).await?;
            let view=substitution_by_id(tx,id).await?; Ok((view,vec![event(&caller,"attendance.substitution.assign","attendance_substitution",id,command.branch_id,Some(json!({"coveredEmployeeId":command.covered_employee_id})))?]))
        })).await
    }

    pub async fn substitution_branch(
        &self,
        org_id: Uuid,
        substitution_id: Uuid,
    ) -> Result<Option<Option<Uuid>>, AttendanceStoreError> {
        with_org_conn::<_, _, AttendanceStoreError>(
            &self.pool,
            OrgId::from_uuid(org_id),
            move |tx| {
                Box::pin(async move {
                    sqlx::query_scalar("SELECT branch_id FROM attendance_substitutions WHERE id=$1")
                        .bind(substitution_id)
                        .fetch_optional(tx.as_mut())
                        .await
                        .map_err(AttendanceStoreError::from)
                })
            },
        )
        .await
    }

    pub async fn cancel_substitution(
        &self,
        caller: &CallerScope,
        command: CancelSubstitution,
    ) -> Result<Value, AttendanceStoreError> {
        let reason = app::validate_text(&command.reason, "reason", 2000)?;
        let org = OrgId::from_uuid(caller.org_id);
        let caller = caller.clone();
        with_audits::<_, _, AttendanceStoreError>(&self.pool, org, move |tx| Box::pin(async move {
            let branch: Option<Uuid> = sqlx::query_scalar("SELECT branch_id FROM attendance_substitutions WHERE id=$1 FOR UPDATE").bind(command.substitution_id).fetch_optional(tx.as_mut()).await?.ok_or(AttendanceStoreError::NotFound)?;
            app::ensure_scope(&caller, branch)?;
            let changed = sqlx::query("UPDATE attendance_substitutions SET status='CANCELLED', cancellation_reason=$1 WHERE id=$2 AND status='OPEN'").bind(&reason).bind(command.substitution_id).execute(tx.as_mut()).await?;
            if changed.rows_affected() != 1 { return Err(AttendanceStoreError::Conflict); }
            Ok((substitution_by_id(tx, command.substitution_id).await?, vec![event(&caller, "attendance.substitution.cancel", "attendance_substitution", command.substitution_id, branch, Some(json!({"reason":reason})))?]))
        })).await
    }

    pub async fn close_checks(
        &self,
        caller: &CallerScope,
        close: &CloseMonth,
    ) -> Result<CloseChecks, AttendanceStoreError> {
        app::ensure_scope(caller, close.branch_scope)?;
        let range = AttendanceDateRange::selected_month_with_buffer(&close.month)?;
        let org = OrgId::from_uuid(caller.org_id);
        with_org_conn::<_, _, AttendanceStoreError>(&self.pool, org, move |tx| {
            Box::pin(async move { close_checks(tx, range.from, close.branch_scope).await })
        })
        .await
    }
    pub async fn close_month(
        &self,
        caller: &CallerScope,
        close: CloseMonth,
    ) -> Result<Value, AttendanceStoreError> {
        if !close.attest {
            return Err(AttendanceStoreError::Application(
                app::AttendanceApplicationError::MissingAttestation,
            ));
        }
        app::ensure_scope(caller, close.branch_scope)?;
        let month = AttendanceDateRange::selected_month_with_buffer(&close.month)?.from;
        let next = month_after(month);
        let last = next - Duration::days(1);
        let org = OrgId::from_uuid(caller.org_id);
        let caller = caller.clone();
        let id = Uuid::new_v4();
        with_audits::<_, _, AttendanceStoreError>(&self.pool, org, move |tx| Box::pin(async move {
            close_month_lock(tx, caller.org_id, month).await?;
            let checks = close_checks(tx, month, close.branch_scope).await?;
            if !checks.ready() { return Err(AttendanceStoreError::CloseBlocked); }
            let checks_json = json!([
                {"key":"open_exceptions","ok":checks.open_exceptions == 0,"note":checks.open_exceptions},
                {"key":"pending_leave","ok":true,"warn":checks.pending_leave > 0,"note":checks.pending_leave},
                {"key":"not_already_closed","ok":!checks.already_closed}
            ]);
            let scope = close.branch_scope.map_or_else(|| "org".to_owned(), |id| id.to_string());
            // A branch close is an attendance evidence snapshot only. It must
            // never acquire or create the organization-wide payroll period lock.
            // Organization-wide closes reuse or create that lock atomically.
            let (lock_id, created_period_lock) = if close.branch_scope.is_some() {
                (None, false)
            } else {
                let existing: Option<Uuid> = sqlx::query_scalar(
                    "SELECT id FROM period_locks WHERE domain='payroll' AND unlocked_at IS NULL AND period_start <= $1 AND period_end >= $2 ORDER BY locked_at DESC LIMIT 1",
                ).bind(month).bind(last).fetch_optional(tx.as_mut()).await?;
                match existing {
                    Some(id) => (Some(id), false),
                    None => {
                        let overlaps: i64 = sqlx::query_scalar(
                            "SELECT count(*) FROM period_locks WHERE domain='payroll' AND unlocked_at IS NULL AND period_start <= $2 AND period_end >= $1",
                        ).bind(month).bind(last).fetch_one(tx.as_mut()).await?;
                        if overlaps != 0 { return Err(AttendanceStoreError::Conflict); }
                        let id = sqlx::query_scalar(
                            "INSERT INTO period_locks (org_id,domain,period_start,period_end,reason,locked_by) VALUES ($1,'payroll',$2,$3,$4,$5) RETURNING id",
                        ).bind(caller.org_id).bind(month).bind(last).bind(format!("attendance close {} ({scope})", close.month)).bind(caller.user_id).fetch_one(tx.as_mut()).await?;
                        (Some(id), true)
                    }
                }
            };
            let inserted = sqlx::query(
                "INSERT INTO attendance_month_closes (id,org_id,month,branch_scope,checks,attested_by,period_lock_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (org_id,month,branch_scope) DO NOTHING",
            ).bind(id).bind(caller.org_id).bind(month).bind(&scope).bind(&checks_json).bind(caller.user_id).bind(lock_id).execute(tx.as_mut()).await?;
            if inserted.rows_affected() != 1 { return Err(AttendanceStoreError::Conflict); }
            let view = json!({"id":id,"month":close.month,"branchScope":scope,"status":"CLOSED","checks":checks_json,"periodLockId":lock_id});
            let mut audits = vec![event(&caller,"attendance.close.confirm","attendance_month_close",id,close.branch_scope,Some(json!({"periodLockId":lock_id})))?];
            if created_period_lock {
                audits.push(event(&caller,"period_lock.create","period_lock",lock_id.expect("created lock id"),None,Some(json!({"domain":"payroll","periodStart":month,"periodEnd":last})))?);
            }
            Ok((view, audits))
        })).await
    }

    pub async fn list_closes(
        &self,
        caller: &CallerScope,
        branch_id: Option<Uuid>,
    ) -> Result<Vec<Value>, AttendanceStoreError> {
        app::ensure_scope(caller, branch_id)?;
        let org = OrgId::from_uuid(caller.org_id);
        with_org_conn::<_, _, AttendanceStoreError>(&self.pool, org, move |tx| Box::pin(async move {
            let scope = branch_id.map_or_else(|| "org".to_owned(), |id| id.to_string());
            let rows = sqlx::query("SELECT id,month,branch_scope,checks,attested_by,period_lock_id FROM attendance_month_closes WHERE branch_scope=$1 ORDER BY month DESC").bind(scope).fetch_all(tx.as_mut()).await?;
            rows.iter().map(close_json).collect::<Result<Vec<_>, _>>()
        })).await
    }

    pub async fn close_branch(
        &self,
        org_id: Uuid,
        close_id: Uuid,
    ) -> Result<Option<Option<Uuid>>, AttendanceStoreError> {
        with_org_conn::<_, _, AttendanceStoreError>(
            &self.pool,
            OrgId::from_uuid(org_id),
            move |tx| {
                Box::pin(async move {
                    let scope: Option<String> = sqlx::query_scalar(
                        "SELECT branch_scope FROM attendance_month_closes WHERE id=$1",
                    )
                    .bind(close_id)
                    .fetch_optional(tx.as_mut())
                    .await?;
                    scope
                        .map(|value| {
                            if value == "org" {
                                Ok(None)
                            } else {
                                Uuid::parse_str(&value)
                                    .map(Some)
                                    .map_err(|_| AttendanceStoreError::Conflict)
                            }
                        })
                        .transpose()
                })
            },
        )
        .await
    }

    pub async fn amend_close(
        &self,
        caller: &CallerScope,
        command: AmendClose,
    ) -> Result<Value, AttendanceStoreError> {
        let reason = app::validate_text(&command.reason, "reason", 2000)?;
        let org = OrgId::from_uuid(caller.org_id);
        let caller = caller.clone();
        with_audits::<_, _, AttendanceStoreError>(&self.pool, org, move |tx| Box::pin(async move {
            let branch_scope: String = sqlx::query_scalar("SELECT branch_scope FROM attendance_month_closes WHERE id=$1 FOR UPDATE").bind(command.close_id).fetch_optional(tx.as_mut()).await?.ok_or(AttendanceStoreError::NotFound)?;
            let branch = if branch_scope == "org" { None } else { Some(Uuid::parse_str(&branch_scope).map_err(|_| AttendanceStoreError::Conflict)?) };
            app::ensure_scope(&caller, branch)?;
            let amendment_id = Uuid::new_v4();
            sqlx::query("INSERT INTO attendance_close_amendments (id,org_id,close_id,reason,amended_by) VALUES ($1,$2,$3,$4,$5)").bind(amendment_id).bind(caller.org_id).bind(command.close_id).bind(&reason).bind(caller.user_id).execute(tx.as_mut()).await?;
            Ok((json!({"id":amendment_id,"closeId":command.close_id,"reason":reason,"status":"AMENDED"}), vec![event(&caller,"attendance.close.amend","attendance_month_close",command.close_id,branch,Some(json!({"amendmentId":amendment_id})))?]))
        })).await
    }

    /// Resolves an active employee's server-owned home branch under the tenant
    /// connection. `None` deliberately covers cross-tenant, inactive, and
    /// branchless employees without leaking which condition applied.
    pub async fn active_employee_home_branch(
        &self,
        org_id: Uuid,
        employee_id: Uuid,
    ) -> Result<Option<Uuid>, AttendanceStoreError> {
        let branch: Option<Option<Uuid>> = with_org_conn::<_, _, AttendanceStoreError>(&self.pool, OrgId::from_uuid(org_id), move |tx| Box::pin(async move {
            sqlx::query_scalar("SELECT home_branch_id FROM employees WHERE id=$1 AND employment_status='ACTIVE' AND home_branch_id IS NOT NULL")
                .bind(employee_id).fetch_optional(tx.as_mut()).await.map_err(AttendanceStoreError::from)
        })).await?;
        branch
            .flatten()
            .ok_or(AttendanceStoreError::NotFound)
            .map(Some)
    }

    pub async fn acknowledge_week52(
        &self,
        caller: &CallerScope,
        command: AcknowledgeWeek52,
    ) -> Result<Value, AttendanceStoreError> {
        let org = OrgId::from_uuid(caller.org_id);
        let caller = caller.clone();
        with_audits::<_, _, AttendanceStoreError>(&self.pool, org, move |tx| Box::pin(async move {
            let branch: Option<Uuid> = sqlx::query_scalar("SELECT home_branch_id FROM employees WHERE id=$1 AND employment_status='ACTIVE' AND home_branch_id IS NOT NULL")
                .bind(command.employee_id).fetch_optional(tx.as_mut()).await?.flatten();
            let branch = branch.ok_or(AttendanceStoreError::NotFound)?;
            app::ensure_scope(&caller, Some(branch))?;
            let inserted: Option<OffsetDateTime> = sqlx::query_scalar("INSERT INTO attendance_week52_acknowledgements (org_id,employee_id,week_start,acknowledged_by) VALUES ($1,$2,$3,$4) ON CONFLICT (org_id,employee_id,week_start) DO NOTHING RETURNING acknowledged_at")
                .bind(caller.org_id).bind(command.employee_id).bind(command.week_start).bind(caller.user_id).fetch_optional(tx.as_mut()).await?;
            let acknowledged_at = match inserted {
                Some(value) => value,
                None => sqlx::query_scalar("SELECT acknowledged_at FROM attendance_week52_acknowledgements WHERE employee_id=$1 AND week_start=$2")
                    .bind(command.employee_id).bind(command.week_start).fetch_optional(tx.as_mut()).await?.ok_or(AttendanceStoreError::NotFound)?,
            };
            let audits = if inserted.is_some() { vec![event(&caller,"attendance.week52.acknowledge","attendance_week52",command.employee_id,Some(branch),Some(json!({"weekStart":command.week_start,"acknowledgedAt":acknowledged_at})))?] } else { Vec::new() };
            Ok((json!({"employeeId":command.employee_id,"weekStart":command.week_start,"acknowledged":true,"acknowledgedAt":acknowledged_at}), audits))
        })).await
    }

    pub async fn week52_inputs(
        &self,
        caller: &CallerScope,
        week_start: Date,
        branch_id: Option<Uuid>,
    ) -> Result<Vec<Week52Input>, AttendanceStoreError> {
        app::ensure_scope(caller, branch_id)?;
        let org = OrgId::from_uuid(caller.org_id);
        let end = week_start + Duration::days(7);
        with_org_conn::<_, _, AttendanceStoreError>(&self.pool, org, move |tx| Box::pin(async move {
            let rows = sqlx::query("SELECT r.employee_id,r.kind,r.occurred_at FROM employee_attendance_records r JOIN employees e ON e.id=r.employee_id AND e.org_id=r.org_id WHERE e.employment_status='ACTIVE' AND r.work_date >= $1 AND r.work_date < $2 AND ($3::uuid IS NULL OR e.home_branch_id=$3) ORDER BY r.employee_id,r.occurred_at,r.id")
                .bind(week_start).bind(end).bind(branch_id).fetch_all(tx.as_mut()).await?;
            let events = rows.iter().map(|row| Ok(Week52Event { employee_id: row.try_get("employee_id")?, kind: row.try_get("kind")?, occurred_at: row.try_get("occurred_at")? })).collect::<Result<Vec<_>, AttendanceStoreError>>()?;
            let hours = week52_hours(&events)?;
            let acknowledgements = sqlx::query("SELECT employee_id,acknowledged_at FROM attendance_week52_acknowledgements WHERE week_start=$1")
                .bind(week_start).fetch_all(tx.as_mut()).await?.into_iter().map(|row| Ok((row.try_get::<Uuid,_>("employee_id")?, row.try_get::<OffsetDateTime,_>("acknowledged_at")?))).collect::<Result<BTreeMap<_,_>, AttendanceStoreError>>()?;
            Ok(hours.into_iter().map(|(employee_id, current_hours)| Week52Input { employee_id, week_start, current_hours, projected_hours: current_hours, acknowledged_at: acknowledgements.get(&employee_id).copied() }).collect())
        })).await
    }
}

#[derive(Debug, Clone)]
struct Week52Event {
    employee_id: Uuid,
    kind: String,
    occurred_at: OffsetDateTime,
}

/// Only complete CLOCK_IN/CLOCK_OUT pairs contribute time. A duplicate open
/// clock-in or unmatched clock-out/open clock-in fails the whole read instead
/// of inventing a duration.
fn week52_hours(events: &[Week52Event]) -> Result<BTreeMap<Uuid, f64>, AttendanceStoreError> {
    let mut open = BTreeMap::<Uuid, OffsetDateTime>::new();
    let mut seconds = BTreeMap::<Uuid, i64>::new();
    for event in events {
        match event.kind.as_str() {
            "CLOCK_IN" => {
                if open.insert(event.employee_id, event.occurred_at).is_some() {
                    return Err(AttendanceStoreError::Conflict);
                }
            }
            "CLOCK_OUT" => {
                let start = open
                    .remove(&event.employee_id)
                    .ok_or(AttendanceStoreError::Conflict)?;
                let elapsed = (event.occurred_at - start).whole_seconds();
                if elapsed < 0 {
                    return Err(AttendanceStoreError::Conflict);
                }
                *seconds.entry(event.employee_id).or_default() += elapsed;
            }
            _ => {}
        }
    }
    if !open.is_empty() {
        return Err(AttendanceStoreError::Conflict);
    }
    Ok(seconds
        .into_iter()
        .map(|(employee, seconds)| (employee, seconds as f64 / 3600.0))
        .collect())
}

fn month_after(month: Date) -> Date {
    if month.month() == time::Month::December {
        Date::from_calendar_date(month.year() + 1, time::Month::January, 1)
            .expect("valid next January")
    } else {
        Date::from_calendar_date(month.year(), month.month().next(), 1).expect("valid next month")
    }
}

fn fingerprint(value: &Value) -> String {
    hex::encode(Sha256::digest(value.to_string()))
}
fn event(
    caller: &CallerScope,
    action: &str,
    kind: &str,
    id: Uuid,
    branch: Option<Uuid>,
    after: Option<Value>,
) -> Result<AuditEvent, AttendanceStoreError> {
    let mut e = AuditEvent::new(
        Some(mnt_kernel_core::UserId::from_uuid(caller.user_id)),
        AuditAction::new(action).map_err(|e| {
            AttendanceStoreError::Application(app::AttendanceApplicationError::InvalidText(
                "audit action",
            ))
        })?,
        kind,
        id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(OrgId::from_uuid(caller.org_id))
    .with_snapshots(None, after);
    if let Some(branch) = branch {
        e = e.with_branch(BranchId::from_uuid(branch));
    }
    Ok(e)
}
async fn ensure_historical_coverage(
    tx: &mut Transaction<'_, Postgres>,
    employee: Uuid,
    window: &mnt_attendance_domain::SubstitutionWindow,
    _exception_id: Option<Uuid>,
) -> Result<(), AttendanceStoreError> {
    if window.cover_date >= OffsetDateTime::now_utc().date() {
        return Ok(());
    }
    // Coupled migration contract: `leave_requests.subject_employee_id UUID NOT NULL`,
    // `start_minutes INTEGER NOT NULL CHECK (start_minutes BETWEEN 0 AND 1439)`,
    // and `end_minutes INTEGER NOT NULL CHECK (end_minutes BETWEEN 1 AND 1440 AND end_minutes > start_minutes)`.
    // Historical substitution admits only an approved absence that fully covers
    // the requested window; there is deliberately no same-day fallback.
    let row = sqlx::query("SELECT subject_employee_id AS employee_id, start_minutes AS from_minutes, end_minutes AS to_minutes FROM leave_requests WHERE subject_employee_id=$1 AND status IN ('approved','APPROVED') AND start_date <= $2 AND end_date >= $2 ORDER BY start_date DESC LIMIT 1")
        .bind(employee).bind(window.cover_date).fetch_optional(tx.as_mut()).await?;
    let Some(row) = row else {
        return Err(AttendanceStoreError::Conflict);
    };
    let absence = HistoricalAbsence::new(
        row.try_get("employee_id")?,
        window.cover_date,
        row.try_get("from_minutes")?,
        row.try_get("to_minutes")?,
    )
    .map_err(app::AttendanceApplicationError::from)?;
    if absence.fully_covers(employee, window) {
        Ok(())
    } else {
        Err(AttendanceStoreError::Conflict)
    }
}

async fn close_month_lock(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    month: Date,
) -> Result<(), AttendanceStoreError> {
    let material = format!("attendance-close-v1|{}|{}", org_id, month);
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(material)
        .execute(tx.as_mut())
        .await?;
    Ok(())
}

async fn idempotency_lock(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    normalized_key: &str,
) -> Result<(), AttendanceStoreError> {
    let material = format!(
        "attendance-idempotency-v1|{}|{}|{}",
        org_id,
        normalized_key.len(),
        normalized_key
    );
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(material)
        .execute(tx.as_mut())
        .await?;
    Ok(())
}

fn substitution_fingerprint(caller: &CallerScope, command: &AssignSubstitute) -> Value {
    // Callers normalize every text field exactly once before this point; the
    // fingerprint therefore describes exactly the persisted semantic row.
    json!({"v":1,"orgId":caller.org_id,"branchPresent":command.branch_id.is_some(),"branchId":command.branch_id,"coverDate":command.window.cover_date,"from":command.window.from_minutes,"to":command.window.to_minutes,"coveredEmployeeId":command.covered_employee_id,"reasonKind":command.reason_kind,"reasonDetailPresent":command.reason_detail.is_some(),"reasonDetail":command.reason_detail,"site":command.site,"role":command.role,"workerEmployeePresent":command.worker_employee_id.is_some(),"workerEmployeeId":command.worker_employee_id,"workerName":command.worker_name,"workerType":command.worker_type,"workerRatePresent":command.worker_rate.is_some(),"workerRate":command.worker_rate,"exceptionPresent":command.exception_id.is_some(),"exceptionId":command.exception_id})
}

async fn close_checks(
    tx: &mut Transaction<'_, Postgres>,
    month: Date,
    branch: Option<Uuid>,
) -> Result<CloseChecks, AttendanceStoreError> {
    let next = month_after(month);
    let open:i64=sqlx::query_scalar("SELECT count(*) FROM attendance_exceptions WHERE status='OPEN' AND work_date >= $1 AND work_date < $2 AND ($3::uuid IS NULL OR branch_id=$3)").bind(month).bind(next).bind(branch).fetch_one(tx.as_mut()).await?;
    let pending:i64=sqlx::query_scalar("SELECT count(*) FROM leave_requests WHERE status IN ('pending','PENDING') AND start_date < $2 AND end_date >= $1 AND ($3::uuid IS NULL OR branch_id=$3)").bind(month).bind(next).bind(branch).fetch_one(tx.as_mut()).await?;
    let scope = branch.map_or_else(|| "org".to_owned(), |id| id.to_string());
    let closed: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM attendance_month_closes WHERE month=$1 AND branch_scope=$2)",
    )
    .bind(month)
    .bind(scope)
    .fetch_one(tx.as_mut())
    .await?;
    Ok(CloseChecks {
        open_exceptions: open,
        pending_leave: pending,
        already_closed: closed,
    })
}
async fn exception_by_id(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<Value, AttendanceStoreError> {
    let r=sqlx::query("SELECT id,code,kind,status,employee_id,branch_id,work_date,detail,created_at FROM attendance_exceptions WHERE id=$1").bind(id).fetch_one(tx.as_mut()).await?;
    exception_json(&r)
}
async fn substitution_by_id(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<Value, AttendanceStoreError> {
    let r=sqlx::query("SELECT id,site,branch_id,role,cover_date,from_minutes,to_minutes,covered_employee_id,reason_kind,worker_employee_id,worker_name,worker_type,status,created_at FROM attendance_substitutions WHERE id=$1").bind(id).fetch_one(tx.as_mut()).await?;
    substitution_json(&r)
}
fn close_json(r: &sqlx::postgres::PgRow) -> Result<Value, AttendanceStoreError> {
    Ok(
        json!({"id":r.try_get::<Uuid,_>("id")?,"month":r.try_get::<Date,_>("month")?.to_string(),"branchScope":r.try_get::<String,_>("branch_scope")?,"checks":r.try_get::<Value,_>("checks")?,"attestedBy":r.try_get::<Uuid,_>("attested_by")?,"periodLockId":r.try_get::<Option<Uuid>,_>("period_lock_id")?}),
    )
}
fn exception_json(r: &sqlx::postgres::PgRow) -> Result<Value, AttendanceStoreError> {
    Ok(
        json!({"id":r.try_get::<Uuid,_>("id")?,"code":r.try_get::<String,_>("code")?,"kind":r.try_get::<String,_>("kind")?,"status":r.try_get::<String,_>("status")?,"employeeId":r.try_get::<Uuid,_>("employee_id")?,"branchId":r.try_get::<Option<Uuid>,_>("branch_id")?,"workDate":r.try_get::<Date,_>("work_date")?.to_string(),"detail":r.try_get::<String,_>("detail")?,"createdAt":r.try_get::<OffsetDateTime,_>("created_at")?.to_string()}),
    )
}
fn substitution_json(r: &sqlx::postgres::PgRow) -> Result<Value, AttendanceStoreError> {
    Ok(
        json!({"id":r.try_get::<Uuid,_>("id")?,"site":r.try_get::<String,_>("site")?,"branchId":r.try_get::<Option<Uuid>,_>("branch_id")?,"role":r.try_get::<String,_>("role")?,"coverDate":r.try_get::<Date,_>("cover_date")?.to_string(),"fromMinutes":r.try_get::<i32,_>("from_minutes")?,"toMinutes":r.try_get::<i32,_>("to_minutes")?,"coveredEmployeeId":r.try_get::<Uuid,_>("covered_employee_id")?,"reasonKind":r.try_get::<String,_>("reason_kind")?,"workerEmployeeId":r.try_get::<Option<Uuid>,_>("worker_employee_id")?,"workerName":r.try_get::<String,_>("worker_name")?,"workerType":r.try_get::<String,_>("worker_type")?,"status":r.try_get::<String,_>("status")?,"createdAt":r.try_get::<OffsetDateTime,_>("created_at")?.to_string()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use mnt_attendance_domain::SubstitutionWindow;
    use time::{Date, Month};

    fn command() -> AssignSubstitute {
        AssignSubstitute {
            window: SubstitutionWindow::new(
                Date::from_calendar_date(2026, Month::July, 2).unwrap(),
                540,
                1020,
            )
            .unwrap(),
            branch_id: Some(Uuid::new_v4()),
            site: "Seoul".into(),
            role: "Operator".into(),
            covered_employee_id: Uuid::new_v4(),
            reason_kind: "APPROVED_LEAVE".into(),
            reason_detail: Some("medical".into()),
            worker_employee_id: Some(Uuid::new_v4()),
            worker_name: "Kim".into(),
            worker_type: "EMPLOYEE".into(),
            worker_rate: Some("10000".into()),
            exception_id: Some(Uuid::new_v4()),
            idempotency_key: "attendance-test-key-0001".into(),
        }
    }
    fn scope() -> CallerScope {
        CallerScope {
            org_id: Uuid::new_v4(),
            user_id: Uuid::new_v4(),
            branch_ids: vec![],
            org_wide: true,
        }
    }
    fn canonicalize(command: &mut AssignSubstitute) {
        command.site = app::validate_text(&command.site, "site", 120).unwrap();
        command.role = app::validate_text(&command.role, "role", 120).unwrap();
        command.reason_kind = app::validate_text(&command.reason_kind, "reasonKind", 60).unwrap();
        command.reason_detail =
            app::normalize_optional_text(command.reason_detail.take(), "reasonDetail", 500)
                .unwrap();
        command.worker_name = app::validate_text(&command.worker_name, "workerName", 120).unwrap();
        command.worker_type = app::validate_text(&command.worker_type, "workerType", 60).unwrap();
        command.worker_rate =
            app::normalize_optional_text(command.worker_rate.take(), "workerRate", 60).unwrap();
    }
    fn assert_fingerprint_changes(
        caller: &CallerScope,
        base: &AssignSubstitute,
        changed: AssignSubstitute,
    ) {
        assert_ne!(
            fingerprint(&substitution_fingerprint(caller, base)),
            fingerprint(&substitution_fingerprint(caller, &changed))
        );
    }
    #[test]
    fn fingerprint_changes_for_every_persisted_semantic_field() {
        let caller = scope();
        let base = command();
        let mut c = base.clone();
        c.branch_id = Some(Uuid::new_v4());
        assert_fingerprint_changes(&caller, &base, c);
        let mut c = base.clone();
        c.window.cover_date += Duration::days(1);
        assert_fingerprint_changes(&caller, &base, c);
        let mut c = base.clone();
        c.window.from_minutes = 541;
        assert_fingerprint_changes(&caller, &base, c);
        let mut c = base.clone();
        c.window.to_minutes = 1019;
        assert_fingerprint_changes(&caller, &base, c);
        let mut c = base.clone();
        c.covered_employee_id = Uuid::new_v4();
        assert_fingerprint_changes(&caller, &base, c);
        let mut c = base.clone();
        c.reason_kind = "OTHER".into();
        assert_fingerprint_changes(&caller, &base, c);
        let mut c = base.clone();
        c.reason_detail = None;
        assert_fingerprint_changes(&caller, &base, c);
        let mut c = base.clone();
        c.site = "Busan".into();
        assert_fingerprint_changes(&caller, &base, c);
        let mut c = base.clone();
        c.role = "Lead".into();
        assert_fingerprint_changes(&caller, &base, c);
        let mut c = base.clone();
        c.worker_employee_id = None;
        assert_fingerprint_changes(&caller, &base, c);
        let mut c = base.clone();
        c.worker_name = "Park".into();
        assert_fingerprint_changes(&caller, &base, c);
        let mut c = base.clone();
        c.worker_type = "CONTRACTOR".into();
        assert_fingerprint_changes(&caller, &base, c);
        let mut c = base.clone();
        c.worker_rate = None;
        assert_fingerprint_changes(&caller, &base, c);
        let mut c = base.clone();
        c.exception_id = None;
        assert_fingerprint_changes(&caller, &base, c);
        let mut other_org = caller.clone();
        other_org.org_id = Uuid::new_v4();
        assert_ne!(
            fingerprint(&substitution_fingerprint(&caller, &base)),
            fingerprint(&substitution_fingerprint(&other_org, &base))
        );
    }
    #[test]
    fn canonical_whitespace_has_the_same_persisted_fingerprint() {
        let caller = scope();
        let mut canonical = command();
        let mut whitespace = command();
        whitespace.site = " Seoul ".into();
        whitespace.role = " Operator ".into();
        whitespace.reason_kind = " APPROVED_LEAVE ".into();
        whitespace.reason_detail = Some(" medical ".into());
        whitespace.worker_name = " Kim ".into();
        whitespace.worker_type = " EMPLOYEE ".into();
        whitespace.worker_rate = Some(" 10000 ".into());
        canonicalize(&mut canonical);
        canonicalize(&mut whitespace);
        assert_eq!(
            substitution_fingerprint(&caller, &canonical),
            substitution_fingerprint(&caller, &whitespace)
        );
    }
    fn event_at(employee_id: Uuid, kind: &str, hours: i64) -> Week52Event {
        Week52Event {
            employee_id,
            kind: kind.to_owned(),
            occurred_at: OffsetDateTime::UNIX_EPOCH + Duration::hours(hours),
        }
    }
    #[test]
    fn week52_derives_only_real_complete_clock_pairs() {
        let employee = Uuid::new_v4();
        let hours = week52_hours(&[
            event_at(employee, "CLOCK_IN", 0),
            event_at(employee, "OUT_FOR_WORK", 1),
            event_at(employee, "CLOCK_OUT", 9),
        ])
        .unwrap();
        assert_eq!(hours.get(&employee), Some(&9.0));
    }
    #[test]
    fn week52_fails_closed_for_repeated_or_missing_clock_pairs() {
        let employee = Uuid::new_v4();
        assert!(week52_hours(&[event_at(employee, "CLOCK_OUT", 1)]).is_err());
        assert!(
            week52_hours(&[
                event_at(employee, "CLOCK_IN", 0),
                event_at(employee, "CLOCK_IN", 1)
            ])
            .is_err()
        );
        assert!(week52_hours(&[event_at(employee, "CLOCK_IN", 0)]).is_err());
    }
    #[test]
    fn historical_interval_contract_covers_full_partial_and_no_coverage() {
        let employee = Uuid::new_v4();
        let date = Date::from_calendar_date(2026, Month::July, 2).unwrap();
        let window = SubstitutionWindow::new(date, 540, 1020).unwrap();
        assert!(
            HistoricalAbsence::new(employee, date, 480, 1080)
                .unwrap()
                .fully_covers(employee, &window)
        );
        assert!(
            !HistoricalAbsence::new(employee, date, 600, 1020)
                .unwrap()
                .fully_covers(employee, &window)
        );
        assert!(
            !HistoricalAbsence::new(Uuid::new_v4(), date, 480, 1080)
                .unwrap()
                .fully_covers(employee, &window)
        );
    }
}
