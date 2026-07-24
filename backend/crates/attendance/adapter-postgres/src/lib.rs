//! Tenant-scoped persistence for attendance.  All SQL is bind-parameterized;
//! reads use RLS-bound connections and mutations write the domain audit event
//! in the same transaction as their state transition.
#![cfg_attr(test, allow(clippy::unwrap_used))]

use mnt_attendance_application::{
    self as app, AssignSubstitute, CallerScope, CloseChecks, CloseMonth, ListSubstitutions,
    RaiseException, ResolveException, Week52Input,
};
use mnt_attendance_domain::{AttendanceDateRange, ExceptionKind, HistoricalAbsence};
use mnt_kernel_core::{AuditAction, AuditEvent, BranchId, KernelError, OrgId, TraceContext};
use mnt_platform_db::{DbError, with_audits, with_org_conn};
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
            let code=mint_code(tx, caller.org_id).await?;
            sqlx::query("INSERT INTO attendance_exceptions (id,org_id,code,kind,employee_id,branch_id,work_date,detail,evidence,links,idempotency_key,request_fingerprint,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'[]'::jsonb,$10,$11,$12)")
                .bind(id).bind(caller.org_id).bind(&code).bind(command.kind.as_db()).bind(command.employee_id).bind(command.branch_id).bind(command.work_date).bind(&detail).bind(command.evidence).bind(&key).bind(&fp).bind(actor).execute(tx.as_mut()).await?;
            let view=exception_by_id(tx,id).await?; let audit=event(&caller,"attendance.exception.raise","attendance_exception",id,command.branch_id,Some(json!({"code":code})))?; Ok((view,vec![audit]))
        })).await
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
        let site = app::validate_text(&command.site, "site", 120)?;
        let role = app::validate_text(&command.role, "role", 120)?;
        let name = app::validate_text(&command.worker_name, "workerName", 120)?;
        let org = OrgId::from_uuid(caller.org_id);
        let caller = caller.clone();
        let id = Uuid::new_v4();
        with_audits::<_, _, AttendanceStoreError>(&self.pool,org,move|tx|Box::pin(async move {
            let request = substitution_fingerprint(&caller, &command, &site, &role, &name); let fp=fingerprint(&request);
            idempotency_lock(tx, caller.org_id, &key).await?;
            if let Some((existing,stored))=sqlx::query_as::<_,(Uuid,String)>("SELECT id,request_fingerprint FROM attendance_substitutions WHERE idempotency_key=$1").bind(&key).fetch_optional(tx.as_mut()).await? { if stored==fp { return Ok((substitution_by_id(tx,existing).await?,Vec::new())); } return Err(AttendanceStoreError::Conflict); }
            ensure_historical_coverage(tx,command.covered_employee_id,&command.window,command.exception_id).await?;
            sqlx::query("INSERT INTO attendance_substitutions (id,org_id,site,branch_id,role,cover_date,from_minutes,to_minutes,covered_employee_id,reason_kind,reason_detail,worker_employee_id,worker_name,worker_type,worker_rate,exception_id,idempotency_key,request_fingerprint,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)")
                .bind(id).bind(caller.org_id).bind(&site).bind(command.branch_id).bind(&role).bind(command.window.cover_date).bind(command.window.from_minutes).bind(command.window.to_minutes).bind(command.covered_employee_id).bind(&command.reason_kind).bind(&command.reason_detail).bind(command.worker_employee_id).bind(&name).bind(&command.worker_type).bind(&command.worker_rate).bind(command.exception_id).bind(&key).bind(&fp).bind(caller.user_id).execute(tx.as_mut()).await?;
            let view=substitution_by_id(tx,id).await?; Ok((view,vec![event(&caller,"attendance.substitution.assign","attendance_substitution",id,command.branch_id,Some(json!({"coveredEmployeeId":command.covered_employee_id})))?]))
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
            // A monthly attendance close is not merely a display state: it arms
            // (or reuses) the immutable payroll period lock in this same audit
            // transaction. Partial active overlaps fail closed.
            let lock_id: Option<Uuid> = sqlx::query_scalar(
                "SELECT id FROM period_locks WHERE domain='payroll' AND unlocked_at IS NULL AND period_start <= $1 AND period_end >= $2 ORDER BY locked_at DESC LIMIT 1",
            ).bind(month).bind(last).fetch_optional(tx.as_mut()).await?;
            let lock_id = match lock_id {
                Some(id) => id,
                None => {
                    let overlaps: i64 = sqlx::query_scalar(
                        "SELECT count(*) FROM period_locks WHERE domain='payroll' AND unlocked_at IS NULL AND period_start <= $2 AND period_end >= $1",
                    ).bind(month).bind(last).fetch_one(tx.as_mut()).await?;
                    if overlaps != 0 { return Err(AttendanceStoreError::Conflict); }
                    sqlx::query_scalar(
                        "INSERT INTO period_locks (org_id,domain,period_start,period_end,reason,locked_by) VALUES ($1,'payroll',$2,$3,$4,$5) RETURNING id",
                    ).bind(caller.org_id).bind(month).bind(last).bind(format!("attendance close {} ({scope})", close.month)).bind(caller.user_id).fetch_one(tx.as_mut()).await?
                }
            };
            let inserted = sqlx::query(
                "INSERT INTO attendance_month_closes (id,org_id,month,branch_scope,checks,attested_by,period_lock_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (org_id,month,branch_scope) DO NOTHING",
            ).bind(id).bind(caller.org_id).bind(month).bind(&scope).bind(&checks_json).bind(caller.user_id).bind(lock_id).execute(tx.as_mut()).await?;
            if inserted.rows_affected() != 1 { return Err(AttendanceStoreError::Conflict); }
            let view = json!({"id":id,"month":close.month,"branchScope":scope,"status":"CLOSED","checks":checks_json,"periodLockId":lock_id});
            Ok((view, vec![event(&caller,"attendance.close.confirm","attendance_month_close",id,close.branch_scope,Some(json!({"periodLockId":lock_id})))?]))
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
        with_org_conn::<_,_,AttendanceStoreError>(&self.pool,org,move|tx|Box::pin(async move { let rows=sqlx::query("SELECT employee_id, COALESCE(sum(EXTRACT(EPOCH FROM (clock_out-clock_in))/3600.0),0)::float8 AS hours FROM employee_attendance_daily WHERE work_date >= $1 AND work_date < $2 AND ($3::uuid IS NULL OR branch_id=$3) GROUP BY employee_id").bind(week_start).bind(end).bind(branch_id).fetch_all(tx.as_mut()).await?; rows.iter().map(|r|Ok(Week52Input{employee_id:r.try_get("employee_id")?,week_start,current_hours:r.try_get("hours")?,projected_hours:r.try_get("hours")?,acknowledged_at:None})).collect::<Result<Vec<_>,AttendanceStoreError>>() })).await
    }
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
async fn mint_code(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
) -> Result<String, AttendanceStoreError> {
    let n: i64 = sqlx::query_scalar(
        "INSERT INTO object_code_sequences (org_id,kind,next_value) VALUES ($1,'attendance_exception',1) ON CONFLICT (org_id,kind) DO UPDATE SET next_value=object_code_sequences.next_value+1 RETURNING next_value",
    )
    .bind(org_id)
    .fetch_one(tx.as_mut())
    .await?;
    Ok(format!("AT-{n:06}"))
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
    let row = sqlx::query("SELECT employee_id, COALESCE(start_minutes,0) AS from_minutes, COALESCE(end_minutes,1440) AS to_minutes FROM leave_requests WHERE employee_id=$1 AND status IN ('approved','APPROVED') AND start_date <= $2 AND end_date >= $2 ORDER BY start_date DESC LIMIT 1")
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

fn substitution_fingerprint(
    caller: &CallerScope,
    command: &AssignSubstitute,
    site: &str,
    role: &str,
    worker_name: &str,
) -> Value {
    json!({"v":1,"orgId":caller.org_id,"branchPresent":command.branch_id.is_some(),"branchId":command.branch_id,"coverDate":command.window.cover_date,"from":command.window.from_minutes,"to":command.window.to_minutes,"coveredEmployeeId":command.covered_employee_id,"reasonKind":command.reason_kind.trim(),"reasonDetailPresent":command.reason_detail.is_some(),"reasonDetail":command.reason_detail.as_deref().map(str::trim),"site":site,"role":role,"workerEmployeePresent":command.worker_employee_id.is_some(),"workerEmployeeId":command.worker_employee_id,"workerName":worker_name,"workerType":command.worker_type.trim(),"workerRatePresent":command.worker_rate.is_some(),"workerRate":command.worker_rate.as_deref().map(str::trim),"exceptionPresent":command.exception_id.is_some(),"exceptionId":command.exception_id})
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
    #[test]
    fn fingerprint_changes_for_every_persisted_semantic_field() {
        let caller = scope();
        let base = command();
        let original = fingerprint(&substitution_fingerprint(
            &caller, &base, "Seoul", "Operator", "Kim",
        ));
        let mut changed = base.clone();
        changed.window.from_minutes = 541;
        assert_ne!(
            original,
            fingerprint(&substitution_fingerprint(
                &caller, &changed, "Seoul", "Operator", "Kim"
            ))
        );
        changed = base.clone();
        changed.reason_detail = None;
        assert_ne!(
            original,
            fingerprint(&substitution_fingerprint(
                &caller, &changed, "Seoul", "Operator", "Kim"
            ))
        );
        changed = base.clone();
        changed.worker_rate = None;
        assert_ne!(
            original,
            fingerprint(&substitution_fingerprint(
                &caller, &changed, "Seoul", "Operator", "Kim"
            ))
        );
        changed = base.clone();
        changed.exception_id = None;
        assert_ne!(
            original,
            fingerprint(&substitution_fingerprint(
                &caller, &changed, "Seoul", "Operator", "Kim"
            ))
        );
    }
    #[test]
    fn historical_interval_rejects_partial_and_accepts_full() {
        let employee = Uuid::new_v4();
        let date = Date::from_calendar_date(2026, Month::July, 2).unwrap();
        let window = SubstitutionWindow::new(date, 540, 1020).unwrap();
        assert!(
            !HistoricalAbsence::new(employee, date, 600, 1020)
                .unwrap()
                .fully_covers(employee, &window)
        );
        assert!(
            HistoricalAbsence::new(employee, date, 480, 1080)
                .unwrap()
                .fully_covers(employee, &window)
        );
    }
}
