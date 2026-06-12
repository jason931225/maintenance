//! Postgres reporting adapter.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::io::Cursor;

use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, BranchScope, KernelError, RegionId, Timestamp, TraceContext,
    UserId,
};
use mnt_platform_db::{DbError, with_audit};
use mnt_platform_excel::{
    CellWrite, DAILY_STATUS_TEMPLATE, DailyStatusSection, SectionFill, TemplateRow,
    fill_template_bytes, umya_spreadsheet,
};
use mnt_reporting_application::{
    ExportedWorkbook, KpiQuery, KpiQueryError, KpiQueryPort, ReportingExportError,
    ReportingExportPort, ReportingExportQuery, WorkDiaryConfirmCommand, WorkDiaryDraftPort,
    WorkDiaryQuery, WorkDiaryUpdateCommand,
};
use mnt_reporting_domain::{
    DailyStatusReport, DailyStatusRow, ExportSourceNote, KpiInputRecord, KpiMetric, KpiReport,
    KpiScope, PeriodicInspectionRow, UnavailableMetric, WorkDiaryActionEntry, WorkDiaryBody,
    WorkDiaryDraft, WorkDiaryStatus, calculate_kpi_report,
};
use sqlx::{PgPool, Postgres, QueryBuilder, Row};
use time::{Date, Duration, OffsetDateTime, Time};

const DAILY_STATUS_TEMPLATE_BYTES: &[u8] =
    include_bytes!("../../../../../docs/reference/일일업무진행현황_0605.xlsx");
const WORK_DIARY_TEMPLATE_BYTES: &[u8] =
    include_bytes!("../../../../../docs/reference/업무일지_26.05.27.xlsx");
const EXCEL_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

struct ExportLogCommand<'a> {
    export_kind: &'static str,
    action: &'static str,
    actor: UserId,
    branch_scope: BranchScope,
    export_date: Date,
    file_name: &'a str,
    source_notes: &'a [ExportSourceNote],
    trace: TraceContext,
    occurred_at: Timestamp,
}

#[derive(Debug, thiserror::Error)]
enum PgReportingError {
    #[error(transparent)]
    Db(#[from] DbError),

    #[error(transparent)]
    Domain(#[from] KernelError),

    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),

    #[error("workbook error: {0}")]
    Workbook(String),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

impl From<PgReportingError> for ReportingExportError {
    fn from(value: PgReportingError) -> Self {
        match value {
            PgReportingError::Db(error) => Self::Database(error.to_string()),
            PgReportingError::Domain(error) => Self::Kernel(error),
            PgReportingError::Sqlx(error) => Self::Database(error.to_string()),
            PgReportingError::Workbook(error) => Self::Workbook(error),
            PgReportingError::Json(error) => Self::Database(error.to_string()),
        }
    }
}

#[derive(Debug, Clone)]
pub struct PgKpiRepository {
    pool: PgPool,
}

pub type PgReportingRepository = PgKpiRepository;

impl PgKpiRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    async fn query_kpis_inner(&self, query: KpiQuery) -> Result<KpiReport, KpiQueryError> {
        if query.period.start >= query.period.end {
            return Err(KernelError::validation("KPI period start must be before end").into());
        }

        let records = self.load_work_order_records(&query).await?;
        let unavailable_metrics = self.unavailable_source_metrics().await?;
        Ok(calculate_kpi_report(
            query.period,
            query.scope,
            &records,
            unavailable_metrics,
        ))
    }

    async fn load_work_order_records(
        &self,
        query: &KpiQuery,
    ) -> Result<Vec<KpiInputRecord>, KpiQueryError> {
        let mut builder = QueryBuilder::<Postgres>::new(
            r#"
            SELECT
                w.id AS work_order_id,
                w.branch_id,
                b.region_id,
                primary_assignment.mechanic_id AS technician_id,
                w.status,
                w.priority,
                w.result_type,
                w.delay_reason,
                w.created_at,
                first_start.occurred_at AS first_in_progress_at,
                completion_approval.approved_at,
                w.target_due_at
            FROM work_orders w
            JOIN branches b ON b.id = w.branch_id
            JOIN LATERAL (
                SELECT approved_at
                FROM work_order_approval_steps
                WHERE work_order_id = w.id
                  AND role IN ('EXECUTIVE', 'ADMIN')
                  AND status = 'APPROVED'
                  AND approved_at IS NOT NULL
                ORDER BY CASE role WHEN 'EXECUTIVE' THEN 1 ELSE 2 END, step_order DESC
                LIMIT 1
            ) completion_approval ON TRUE
            LEFT JOIN LATERAL (
                SELECT occurred_at
                FROM work_order_status_history
                WHERE work_order_id = w.id
                  AND to_status = 'IN_PROGRESS'
                ORDER BY occurred_at, id
                LIMIT 1
            ) first_start ON TRUE
            LEFT JOIN LATERAL (
                SELECT mechanic_id
                FROM work_order_assignments
                WHERE work_order_id = w.id
                  AND role = 'PRIMARY'
                ORDER BY assigned_at, id
                LIMIT 1
            ) primary_assignment ON TRUE
            WHERE completion_approval.approved_at >=
            "#,
        );
        builder.push_bind(query.period.start);
        builder.push(" AND completion_approval.approved_at < ");
        builder.push_bind(query.period.end);
        builder.push(" AND w.kpi_excluded = FALSE");
        builder.push(
            r#"
            AND NOT EXISTS (
                SELECT 1
                FROM kpi_exclusions ex
                WHERE ex.scope = 'WORK_ORDER'
                  AND ex.target_id = w.id
                  AND ex.revoked_at IS NULL
            )
            AND NOT EXISTS (
                SELECT 1
                FROM outsource_works ow
                JOIN kpi_exclusions ex
                  ON ex.scope = 'OUTSOURCE'
                 AND ex.target_id = ow.id
                 AND ex.revoked_at IS NULL
                WHERE ow.work_order_id = w.id
            )
            AND
            "#,
        );
        push_branch_scope_filter(&mut builder, &query.branch_scope);
        push_requested_scope_filter(&mut builder, query.scope);
        builder.push(" ORDER BY completion_approval.approved_at, w.id");

        let rows = builder
            .build()
            .fetch_all(&self.pool)
            .await
            .map_err(|err| KpiQueryError::Database(err.to_string()))?;

        rows.iter()
            .map(record_from_row)
            .collect::<Result<Vec<_>, _>>()
    }

    async fn unavailable_source_metrics(&self) -> Result<Vec<UnavailableMetric>, KpiQueryError> {
        let mut unavailable = Vec::new();
        if !self
            .has_any_table(&["regular_inspection_schedules", "inspection_schedules"])
            .await?
        {
            unavailable.push(UnavailableMetric {
                metric: KpiMetric::InspectionPlanCompletionRate,
                source_domain: "inspection".to_owned(),
                reason: "regular inspection schedule source tables are not present in this migration set; T6.4 has not merged"
                    .to_owned(),
            });
        }
        if !self
            .has_any_table(&[
                "p1_broadcasts",
                "p1_broadcast_responses",
                "dispatch_broadcasts",
                "dispatch_broadcast_responses",
            ])
            .await?
        {
            unavailable.push(UnavailableMetric {
                metric: KpiMetric::P1AcceptanceRate,
                source_domain: "dispatch".to_owned(),
                reason: "P1 dispatch broadcast response source tables are not present in this migration set; T2.4 has not merged"
                    .to_owned(),
            });
        }
        Ok(unavailable)
    }

    async fn has_any_table(&self, table_names: &[&str]) -> Result<bool, KpiQueryError> {
        for table_name in table_names {
            let exists: bool = sqlx::query_scalar("SELECT to_regclass($1) IS NOT NULL")
                .bind(table_name)
                .fetch_one(&self.pool)
                .await
                .map_err(|err| KpiQueryError::Database(err.to_string()))?;
            if exists {
                return Ok(true);
            }
        }
        Ok(false)
    }

    async fn export_daily_status_inner(
        &self,
        query: ReportingExportQuery,
    ) -> Result<ExportedWorkbook, PgReportingError> {
        let report = self.daily_status_report(&query).await?;
        let bytes = render_daily_status(&report)?;
        let file_name = format!("daily-status-{}.xlsx", iso_date(query.date));
        self.record_export_log(ExportLogCommand {
            export_kind: "daily_status",
            action: "export.daily_status",
            actor: query.actor,
            branch_scope: query.branch_scope,
            export_date: query.date,
            file_name: &file_name,
            source_notes: &report.source_notes,
            trace: query.trace,
            occurred_at: query.occurred_at,
        })
        .await?;

        Ok(ExportedWorkbook {
            file_name,
            content_type: EXCEL_CONTENT_TYPE,
            bytes,
        })
    }

    async fn export_work_diary_inner(
        &self,
        query: ReportingExportQuery,
    ) -> Result<ExportedWorkbook, PgReportingError> {
        let draft = self
            .get_or_generate_work_diary_inner(WorkDiaryQuery {
                actor: query.actor,
                date: query.date,
                branch_scope: query.branch_scope.clone(),
                trace: query.trace.clone(),
                occurred_at: query.occurred_at,
            })
            .await?;
        let bytes = render_work_diary(query.date, &draft.body)?;
        let file_name = format!("work-diary-{}.xlsx", iso_date(query.date));
        self.record_export_log(ExportLogCommand {
            export_kind: "work_diary",
            action: "export.work_diary",
            actor: query.actor,
            branch_scope: query.branch_scope,
            export_date: query.date,
            file_name: &file_name,
            source_notes: &draft.body.source_notes,
            trace: query.trace,
            occurred_at: query.occurred_at,
        })
        .await?;

        Ok(ExportedWorkbook {
            file_name,
            content_type: EXCEL_CONTENT_TYPE,
            bytes,
        })
    }

    async fn get_or_generate_work_diary_inner(
        &self,
        query: WorkDiaryQuery,
    ) -> Result<WorkDiaryDraft, PgReportingError> {
        let scope_key = scope_key(&query.branch_scope);
        if let Some(draft) = self.fetch_work_diary(query.date, &scope_key).await? {
            return Ok(draft);
        }

        let body = self.generate_work_diary_body(&query).await?;
        let body_value = serde_json::to_value(&body)?;
        let draft_id = uuid::Uuid::new_v4();
        let branch_id = single_branch(&query.branch_scope);
        let event = audit_event(
            "work_diary.generate",
            query.actor,
            "work_diary_draft",
            draft_id,
            branch_id,
            query.trace,
            query.occurred_at,
        )?;

        let actor = *query.actor.as_uuid();
        let date = query.date;
        let status = WorkDiaryStatus::Draft.as_str();
        let scope_key_for_insert = scope_key.clone();
        let branch_uuid = branch_id.map(|id| *id.as_uuid());
        let occurred_at = query.occurred_at;
        with_audit::<_, (), PgReportingError>(&self.pool, event, |tx| {
            Box::pin(async move {
                sqlx::query(
                    r#"
                    INSERT INTO work_diary_drafts (
                        id, diary_date, branch_id, scope_key, status, body,
                        generated_by, generated_at, created_at, updated_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8)
                    "#,
                )
                .bind(draft_id)
                .bind(date)
                .bind(branch_uuid)
                .bind(scope_key_for_insert)
                .bind(status)
                .bind(body_value)
                .bind(actor)
                .bind(occurred_at)
                .execute(tx.as_mut())
                .await?;
                Ok(())
            })
        })
        .await?;

        self.fetch_work_diary(query.date, &scope_key)
            .await?
            .ok_or_else(|| {
                KernelError::not_found("generated work diary draft was not found after insert")
                    .into()
            })
    }

    async fn update_work_diary_inner(
        &self,
        command: WorkDiaryUpdateCommand,
    ) -> Result<WorkDiaryDraft, PgReportingError> {
        let scope_key = scope_key(&command.branch_scope);
        let existing = self
            .fetch_work_diary(command.date, &scope_key)
            .await?
            .ok_or_else(|| KernelError::not_found("work diary draft was not found"))?;
        if existing.status != WorkDiaryStatus::Draft {
            return Err(KernelError::conflict("confirmed work diary cannot be edited").into());
        }

        let body_value = serde_json::to_value(&command.body)?;
        let event = audit_event(
            "work_diary.update",
            command.actor,
            "work_diary_draft",
            existing.id,
            single_branch(&command.branch_scope),
            command.trace,
            command.occurred_at,
        )?;

        let actor = *command.actor.as_uuid();
        let date = command.date;
        let occurred_at = command.occurred_at;
        let scope_key_for_update = scope_key.clone();
        with_audit::<_, (), PgReportingError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let rows = sqlx::query(
                    r#"
                    UPDATE work_diary_drafts
                    SET body = $3,
                        edited_by = $4,
                        edited_at = $5,
                        updated_at = $5
                    WHERE diary_date = $1
                      AND scope_key = $2
                      AND status = 'DRAFT'
                    "#,
                )
                .bind(date)
                .bind(scope_key_for_update)
                .bind(body_value)
                .bind(actor)
                .bind(occurred_at)
                .execute(tx.as_mut())
                .await?
                .rows_affected();
                if rows != 1 {
                    return Err(KernelError::conflict("work diary draft was not editable").into());
                }
                Ok(())
            })
        })
        .await?;

        self.fetch_work_diary(command.date, &scope_key)
            .await?
            .ok_or_else(|| KernelError::not_found("work diary draft was not found").into())
    }

    async fn confirm_work_diary_inner(
        &self,
        command: WorkDiaryConfirmCommand,
    ) -> Result<WorkDiaryDraft, PgReportingError> {
        let scope_key = scope_key(&command.branch_scope);
        let existing = self
            .fetch_work_diary(command.date, &scope_key)
            .await?
            .ok_or_else(|| KernelError::not_found("work diary draft was not found"))?;
        if existing.status != WorkDiaryStatus::Draft {
            return Err(KernelError::conflict("work diary is already confirmed").into());
        }

        let event = audit_event(
            "work_diary.confirm",
            command.actor,
            "work_diary_draft",
            existing.id,
            single_branch(&command.branch_scope),
            command.trace,
            command.occurred_at,
        )?;

        let actor = *command.actor.as_uuid();
        let date = command.date;
        let occurred_at = command.occurred_at;
        let scope_key_for_update = scope_key.clone();
        with_audit::<_, (), PgReportingError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let rows = sqlx::query(
                    r#"
                    UPDATE work_diary_drafts
                    SET status = 'CONFIRMED',
                        confirmed_by = $3,
                        confirmed_at = $4,
                        updated_at = $4
                    WHERE diary_date = $1
                      AND scope_key = $2
                      AND status = 'DRAFT'
                    "#,
                )
                .bind(date)
                .bind(scope_key_for_update)
                .bind(actor)
                .bind(occurred_at)
                .execute(tx.as_mut())
                .await?
                .rows_affected();
                if rows != 1 {
                    return Err(
                        KernelError::conflict("work diary draft was not confirmable").into(),
                    );
                }
                Ok(())
            })
        })
        .await?;

        self.fetch_work_diary(command.date, &scope_key)
            .await?
            .ok_or_else(|| KernelError::not_found("work diary draft was not found").into())
    }

    async fn daily_status_report(
        &self,
        query: &ReportingExportQuery,
    ) -> Result<DailyStatusReport, PgReportingError> {
        let source_notes = self.export_source_notes().await?;
        Ok(DailyStatusReport {
            date: query.date,
            results: self
                .load_completed_rows(query.date, &query.branch_scope)
                .await?,
            plans: self.load_plan_rows(query.date, &query.branch_scope).await?,
            pending_backlog: self.load_pending_rows(&query.branch_scope).await?,
            periodic_inspections: Vec::new(),
            source_notes,
        })
    }

    async fn generate_work_diary_body(
        &self,
        query: &WorkDiaryQuery,
    ) -> Result<WorkDiaryBody, PgReportingError> {
        let source_notes = self.export_source_notes().await?;
        let previous_results = self
            .load_completed_rows(query.date, &query.branch_scope)
            .await?;
        let next_date = query
            .date
            .next_day()
            .ok_or_else(|| KernelError::validation("work diary date overflow"))?;
        let today_plans = self.load_plan_rows(next_date, &query.branch_scope).await?;
        let urgent_actions = self
            .load_work_diary_action_entries(query.date, &query.branch_scope)
            .await?;

        Ok(WorkDiaryBody {
            previous_results: diary_results_text(&previous_results),
            today_plans: diary_plans_text(&today_plans),
            urgent_actions,
            source_notes,
        })
    }

    async fn record_export_log(
        &self,
        command: ExportLogCommand<'_>,
    ) -> Result<(), PgReportingError> {
        let log_id = uuid::Uuid::new_v4();
        let branch_id = single_branch(&command.branch_scope);
        let event = audit_event(
            command.action,
            command.actor,
            "excel_export",
            log_id,
            branch_id,
            command.trace,
            command.occurred_at,
        )?;
        let actor_uuid = *command.actor.as_uuid();
        let branch_uuid = branch_id.map(|id| *id.as_uuid());
        let scope_key = scope_key(&command.branch_scope);
        let source_notes = serde_json::to_value(command.source_notes)?;
        let file_name = command.file_name.to_owned();
        let export_kind = command.export_kind;
        let export_date = command.export_date;
        let occurred_at = command.occurred_at;

        with_audit::<_, (), PgReportingError>(&self.pool, event, |tx| {
            Box::pin(async move {
                sqlx::query(
                    r#"
                    INSERT INTO excel_export_logs (
                        id, actor, branch_id, scope_key, export_kind, export_date,
                        file_name, source_notes, created_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    "#,
                )
                .bind(log_id)
                .bind(actor_uuid)
                .bind(branch_uuid)
                .bind(scope_key)
                .bind(export_kind)
                .bind(export_date)
                .bind(file_name)
                .bind(source_notes)
                .bind(occurred_at)
                .execute(tx.as_mut())
                .await?;
                Ok(())
            })
        })
        .await
    }

    async fn fetch_work_diary(
        &self,
        date: Date,
        scope_key: &str,
    ) -> Result<Option<WorkDiaryDraft>, PgReportingError> {
        let row = sqlx::query(
            r#"
            SELECT id, diary_date, status, body, confirmed_by, confirmed_at
            FROM work_diary_drafts
            WHERE diary_date = $1
              AND scope_key = $2
            "#,
        )
        .bind(date)
        .bind(scope_key)
        .fetch_optional(&self.pool)
        .await?;

        row.map(|row| draft_from_row(&row)).transpose()
    }

    async fn load_completed_rows(
        &self,
        date: Date,
        branch_scope: &BranchScope,
    ) -> Result<Vec<DailyStatusRow>, PgReportingError> {
        let (start, end) = day_bounds(date);
        let mut builder = QueryBuilder::<Postgres>::new(
            r#"
            SELECT
                w.created_at::date AS request_date,
                s.name AS site_name,
                e.management_no,
                e.model,
                e.vin,
                w.symptom,
                primary_assignment.mechanic_name,
                w.target_due_at::date AS scheduled_date,
                completion_approval.approved_at::date AS completed_date,
                w.action_taken AS result_note,
                w.priority,
                w.status
            FROM work_orders w
            JOIN registry_equipment e ON e.id = w.equipment_id
            JOIN registry_sites s ON s.id = w.site_id
            JOIN LATERAL (
                SELECT approved_at
                FROM work_order_approval_steps
                WHERE work_order_id = w.id
                  AND role IN ('EXECUTIVE', 'ADMIN')
                  AND status = 'APPROVED'
                  AND approved_at IS NOT NULL
                ORDER BY CASE role WHEN 'EXECUTIVE' THEN 1 ELSE 2 END, step_order DESC
                LIMIT 1
            ) completion_approval ON TRUE
            LEFT JOIN LATERAL (
                SELECT u.display_name AS mechanic_name
                FROM work_order_assignments a
                JOIN users u ON u.id = a.mechanic_id
                WHERE a.work_order_id = w.id
                  AND a.role = 'PRIMARY'
                ORDER BY a.assigned_at, a.id
                LIMIT 1
            ) primary_assignment ON TRUE
            WHERE w.status = 'FINAL_COMPLETED'
              AND completion_approval.approved_at >=
            "#,
        );
        builder.push_bind(start);
        builder.push(" AND completion_approval.approved_at < ");
        builder.push_bind(end);
        builder.push(" AND ");
        push_branch_column_filter(&mut builder, branch_scope, "w.branch_id");
        builder.push(" ORDER BY completion_approval.approved_at, w.request_no");

        let rows = builder.build().fetch_all(&self.pool).await?;
        rows.iter().map(daily_status_row_from_row).collect()
    }

    async fn load_plan_rows(
        &self,
        date: Date,
        branch_scope: &BranchScope,
    ) -> Result<Vec<DailyStatusRow>, PgReportingError> {
        let mut builder = QueryBuilder::<Postgres>::new(
            r#"
            SELECT
                w.created_at::date AS request_date,
                COALESCE(s.name, i.description) AS site_name,
                e.management_no,
                e.model,
                e.vin,
                COALESCE(w.symptom, i.description) AS symptom,
                u.display_name AS mechanic_name,
                COALESCE(w.target_due_at::date, p.plan_date) AS scheduled_date,
                NULL::date AS completed_date,
                i.description AS result_note,
                COALESCE(w.priority, 'UNSET') AS priority,
                COALESCE(w.status, p.status) AS status
            FROM daily_work_plans p
            JOIN daily_work_plan_items i ON i.plan_id = p.id
            JOIN users u ON u.id = p.mechanic_id
            LEFT JOIN work_orders w ON w.id = i.work_order_id
            LEFT JOIN registry_equipment e ON e.id = w.equipment_id
            LEFT JOIN registry_sites s ON s.id = w.site_id
            WHERE p.plan_date =
            "#,
        );
        builder.push_bind(date);
        builder.push(" AND p.status IN ('APPROVED', 'FINAL_CONFIRMED') AND ");
        push_branch_column_filter(&mut builder, branch_scope, "p.branch_id");
        builder.push(" ORDER BY u.display_name, i.sort_order, i.id");

        let rows = builder.build().fetch_all(&self.pool).await?;
        rows.iter().map(daily_status_row_from_row).collect()
    }

    async fn load_pending_rows(
        &self,
        branch_scope: &BranchScope,
    ) -> Result<Vec<DailyStatusRow>, PgReportingError> {
        let mut builder = QueryBuilder::<Postgres>::new(
            r#"
            SELECT
                w.created_at::date AS request_date,
                s.name AS site_name,
                e.management_no,
                e.model,
                e.vin,
                w.symptom,
                primary_assignment.mechanic_name,
                w.target_due_at::date AS scheduled_date,
                NULL::date AS completed_date,
                w.action_taken AS result_note,
                w.priority,
                w.status
            FROM work_orders w
            JOIN registry_equipment e ON e.id = w.equipment_id
            JOIN registry_sites s ON s.id = w.site_id
            LEFT JOIN LATERAL (
                SELECT u.display_name AS mechanic_name
                FROM work_order_assignments a
                JOIN users u ON u.id = a.mechanic_id
                WHERE a.work_order_id = w.id
                  AND a.role = 'PRIMARY'
                ORDER BY a.assigned_at, a.id
                LIMIT 1
            ) primary_assignment ON TRUE
            WHERE w.status NOT IN ('FINAL_COMPLETED', 'REJECTED', 'ARCHIVED', 'CANCELLED')
              AND
            "#,
        );
        push_branch_column_filter(&mut builder, branch_scope, "w.branch_id");
        builder.push(" ORDER BY w.created_at, w.request_no");

        let rows = builder.build().fetch_all(&self.pool).await?;
        rows.iter().map(daily_status_row_from_row).collect()
    }

    async fn load_work_diary_action_entries(
        &self,
        date: Date,
        branch_scope: &BranchScope,
    ) -> Result<Vec<WorkDiaryActionEntry>, PgReportingError> {
        let (start, end) = day_bounds(date);
        let mut builder = QueryBuilder::<Postgres>::new(
            r#"
            SELECT
                s.name AS site_name,
                e.management_no,
                w.diagnosis,
                w.action_taken
            FROM work_orders w
            JOIN registry_equipment e ON e.id = w.equipment_id
            JOIN registry_sites s ON s.id = w.site_id
            JOIN LATERAL (
                SELECT approved_at
                FROM work_order_approval_steps
                WHERE work_order_id = w.id
                  AND role IN ('EXECUTIVE', 'ADMIN')
                  AND status = 'APPROVED'
                  AND approved_at IS NOT NULL
                ORDER BY CASE role WHEN 'EXECUTIVE' THEN 1 ELSE 2 END, step_order DESC
                LIMIT 1
            ) completion_approval ON TRUE
            WHERE completion_approval.approved_at >=
            "#,
        );
        builder.push_bind(start);
        builder.push(" AND completion_approval.approved_at < ");
        builder.push_bind(end);
        builder.push(" AND (w.diagnosis IS NOT NULL OR w.action_taken IS NOT NULL) AND ");
        push_branch_column_filter(&mut builder, branch_scope, "w.branch_id");
        builder.push(" ORDER BY completion_approval.approved_at, w.request_no");

        let rows = builder.build().fetch_all(&self.pool).await?;
        rows.iter().map(action_entry_from_row).collect()
    }

    async fn export_source_notes(&self) -> Result<Vec<ExportSourceNote>, PgReportingError> {
        if self
            .has_any_table_reporting(&["regular_inspection_schedules", "inspection_schedules"])
            .await?
        {
            return Ok(Vec::new());
        }
        Ok(vec![ExportSourceNote {
            source_domain: "inspection".to_owned(),
            reason: "regular inspection schedule source tables are not present in this migration set; T6.4 has not merged"
                .to_owned(),
        }])
    }

    async fn has_any_table_reporting(
        &self,
        table_names: &[&str],
    ) -> Result<bool, PgReportingError> {
        for table_name in table_names {
            let exists: bool = sqlx::query_scalar("SELECT to_regclass($1) IS NOT NULL")
                .bind(table_name)
                .fetch_one(&self.pool)
                .await?;
            if exists {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

impl KpiQueryPort for PgKpiRepository {
    async fn query_kpis(&self, query: KpiQuery) -> Result<KpiReport, KpiQueryError> {
        self.query_kpis_inner(query).await
    }
}

impl ReportingExportPort for PgKpiRepository {
    async fn export_daily_status(
        &self,
        query: ReportingExportQuery,
    ) -> Result<ExportedWorkbook, ReportingExportError> {
        self.export_daily_status_inner(query)
            .await
            .map_err(Into::into)
    }

    async fn export_work_diary(
        &self,
        query: ReportingExportQuery,
    ) -> Result<ExportedWorkbook, ReportingExportError> {
        self.export_work_diary_inner(query)
            .await
            .map_err(Into::into)
    }
}

impl WorkDiaryDraftPort for PgKpiRepository {
    async fn get_or_generate_work_diary(
        &self,
        query: WorkDiaryQuery,
    ) -> Result<WorkDiaryDraft, ReportingExportError> {
        self.get_or_generate_work_diary_inner(query)
            .await
            .map_err(Into::into)
    }

    async fn update_work_diary(
        &self,
        command: WorkDiaryUpdateCommand,
    ) -> Result<WorkDiaryDraft, ReportingExportError> {
        self.update_work_diary_inner(command)
            .await
            .map_err(Into::into)
    }

    async fn confirm_work_diary(
        &self,
        command: WorkDiaryConfirmCommand,
    ) -> Result<WorkDiaryDraft, ReportingExportError> {
        self.confirm_work_diary_inner(command)
            .await
            .map_err(Into::into)
    }
}

fn push_branch_scope_filter(builder: &mut QueryBuilder<Postgres>, branch_scope: &BranchScope) {
    push_branch_column_filter(builder, branch_scope, "w.branch_id");
}

fn push_branch_column_filter(
    builder: &mut QueryBuilder<Postgres>,
    branch_scope: &BranchScope,
    column: &'static str,
) {
    match branch_scope {
        BranchScope::All => {
            builder.push("TRUE");
        }
        BranchScope::Branches(branches) if branches.is_empty() => {
            builder.push("FALSE");
        }
        BranchScope::Branches(branches) => {
            let branch_ids = branches
                .iter()
                .map(|branch_id| *branch_id.as_uuid())
                .collect::<Vec<_>>();
            builder.push(column);
            builder.push(" = ANY(");
            builder.push_bind(branch_ids);
            builder.push(")");
        }
    };
}

fn push_requested_scope_filter(builder: &mut QueryBuilder<Postgres>, scope: KpiScope) {
    match scope {
        KpiScope::Company => {}
        KpiScope::Region(region_id) => {
            builder.push(" AND b.region_id = ");
            builder.push_bind(*region_id.as_uuid());
        }
        KpiScope::Branch(branch_id) => {
            builder.push(" AND w.branch_id = ");
            builder.push_bind(*branch_id.as_uuid());
        }
        KpiScope::Technician(user_id) => {
            builder.push(" AND primary_assignment.mechanic_id = ");
            builder.push_bind(*user_id.as_uuid());
        }
    }
}

fn record_from_row(row: &sqlx::postgres::PgRow) -> Result<KpiInputRecord, KpiQueryError> {
    let work_order_id = row
        .try_get::<uuid::Uuid, _>("work_order_id")
        .map_err(row_error)?;
    let branch_id = row
        .try_get::<uuid::Uuid, _>("branch_id")
        .map_err(row_error)?;
    let region_id = row
        .try_get::<uuid::Uuid, _>("region_id")
        .map_err(row_error)?;
    let technician_id = row
        .try_get::<Option<uuid::Uuid>, _>("technician_id")
        .map_err(row_error)?;
    Ok(KpiInputRecord {
        work_order_id,
        branch_id: BranchId::from_uuid(branch_id),
        region_id: RegionId::from_uuid(region_id),
        technician_id: technician_id.map(UserId::from_uuid),
        status: row.try_get("status").map_err(row_error)?,
        priority: row.try_get("priority").map_err(row_error)?,
        result_type: row.try_get("result_type").map_err(row_error)?,
        delay_reason: row.try_get("delay_reason").map_err(row_error)?,
        created_at: row.try_get("created_at").map_err(row_error)?,
        first_in_progress_at: row.try_get("first_in_progress_at").map_err(row_error)?,
        approved_at: row.try_get("approved_at").map_err(row_error)?,
        target_due_at: row.try_get("target_due_at").map_err(row_error)?,
    })
}

fn row_error(error: sqlx::Error) -> KpiQueryError {
    KpiQueryError::Database(error.to_string())
}

fn day_bounds(date: Date) -> (OffsetDateTime, OffsetDateTime) {
    let start = date.with_time(Time::MIDNIGHT).assume_utc();
    (start, start + Duration::days(1))
}

fn daily_status_row_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<DailyStatusRow, PgReportingError> {
    Ok(DailyStatusRow {
        request_date: row.try_get("request_date")?,
        site_name: row.try_get("site_name")?,
        management_no: row.try_get("management_no")?,
        model: row.try_get("model")?,
        vin: row.try_get("vin")?,
        symptom: row.try_get("symptom")?,
        mechanic_name: row.try_get("mechanic_name")?,
        scheduled_date: row.try_get("scheduled_date")?,
        completed_date: row.try_get("completed_date")?,
        result_note: row.try_get("result_note")?,
        priority: row.try_get("priority")?,
        status: row.try_get("status")?,
    })
}

fn action_entry_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<WorkDiaryActionEntry, PgReportingError> {
    Ok(WorkDiaryActionEntry {
        site_name: row.try_get("site_name")?,
        management_no: management_no_display(row.try_get::<Option<String>, _>("management_no")?)
            .unwrap_or_default(),
        diagnosis: row
            .try_get::<Option<String>, _>("diagnosis")?
            .unwrap_or_default(),
        action_taken: row
            .try_get::<Option<String>, _>("action_taken")?
            .unwrap_or_default(),
    })
}

fn draft_from_row(row: &sqlx::postgres::PgRow) -> Result<WorkDiaryDraft, PgReportingError> {
    let status_raw: String = row.try_get("status")?;
    let body: serde_json::Value = row.try_get("body")?;
    let confirmed_by: Option<uuid::Uuid> = row.try_get("confirmed_by")?;
    Ok(WorkDiaryDraft {
        id: row.try_get("id")?,
        date: row.try_get("diary_date")?,
        status: WorkDiaryStatus::from_db_str(&status_raw)?,
        body: serde_json::from_value(body)?,
        confirmed_by: confirmed_by.map(UserId::from_uuid),
        confirmed_at: row.try_get("confirmed_at")?,
    })
}

fn render_daily_status(report: &DailyStatusReport) -> Result<Vec<u8>, PgReportingError> {
    fill_template_bytes(
        DAILY_STATUS_TEMPLATE_BYTES,
        &DAILY_STATUS_TEMPLATE,
        &[
            SectionFill::new(
                DailyStatusSection::Results,
                status_rows_to_template(&report.results, SectionKind::Results),
            ),
            SectionFill::new(
                DailyStatusSection::Plans,
                status_rows_to_template(&report.plans, SectionKind::Plans),
            ),
            SectionFill::new(
                DailyStatusSection::PendingBacklog,
                status_rows_to_template(&report.pending_backlog, SectionKind::Pending),
            ),
            SectionFill::new(
                DailyStatusSection::PeriodicInspection,
                inspection_rows_to_template(&report.periodic_inspections),
            ),
        ],
    )
    .map_err(|error| PgReportingError::Workbook(error.to_string()))
}

#[derive(Clone, Copy)]
enum SectionKind {
    Results,
    Plans,
    Pending,
}

fn status_rows_to_template(rows: &[DailyStatusRow], section: SectionKind) -> Vec<TemplateRow> {
    rows.iter()
        .enumerate()
        .map(|(index, row)| {
            let mut cells = vec![
                CellWrite::text(1, "미"),
                CellWrite::text(2, (index + 1).to_string()),
                CellWrite::text(3, date_text(row.request_date)),
                CellWrite::text(4, row.site_name.clone()),
                CellWrite::text(
                    5,
                    management_no_display(row.management_no.clone()).unwrap_or_default(),
                ),
                CellWrite::text(6, row.model.clone().unwrap_or_default()),
                CellWrite::text(7, row.vin.clone().unwrap_or_default()),
                CellWrite::text(8, row.symptom.clone()),
                CellWrite::text(9, row.mechanic_name.clone().unwrap_or_default()),
                CellWrite::text(10, date_text(row.scheduled_date)),
                CellWrite::text(11, date_text(row.completed_date)),
                CellWrite::text(12, row.result_note.clone().unwrap_or_default()),
            ];
            match section {
                SectionKind::Results | SectionKind::Plans => {
                    cells.push(CellWrite::text(13, priority_warning(&row.priority)));
                }
                SectionKind::Pending => {
                    cells.push(CellWrite::text(13, row.status.clone()));
                    cells.push(CellWrite::text(
                        14,
                        if row.priority == "OUTSOURCE" {
                            "외"
                        } else {
                            ""
                        },
                    ));
                }
            }
            TemplateRow::new(cells)
        })
        .collect()
}

fn inspection_rows_to_template(rows: &[PeriodicInspectionRow]) -> Vec<TemplateRow> {
    rows.iter()
        .enumerate()
        .map(|(index, row)| {
            TemplateRow::new([
                CellWrite::text(2, (index + 1).to_string()),
                CellWrite::text(3, row.site_name.clone()),
                CellWrite::text(4, row.vehicle_no.clone().unwrap_or_default()),
                CellWrite::text(
                    5,
                    management_no_display(row.management_no.clone()).unwrap_or_default(),
                ),
                CellWrite::text(6, row.model.clone().unwrap_or_default()),
                CellWrite::text(7, row.serial_no.clone().unwrap_or_default()),
                CellWrite::text(8, row.issue.clone()),
                CellWrite::text(9, row.inspection_period.clone().unwrap_or_default()),
                CellWrite::text(12, row.note.clone().unwrap_or_default()),
            ])
        })
        .collect()
}

fn render_work_diary(date: Date, body: &WorkDiaryBody) -> Result<Vec<u8>, PgReportingError> {
    let mut workbook =
        umya_spreadsheet::reader::xlsx::read_reader(Cursor::new(WORK_DIARY_TEMPLATE_BYTES), true)
            .map_err(|error| PgReportingError::Workbook(error.to_string()))?;
    let sheet_name = work_diary_sheet_name(date);
    workbook
        .set_sheet_name(0, sheet_name.clone())
        .map_err(|error| PgReportingError::Workbook(error.to_string()))?;
    let next_date = date
        .next_day()
        .ok_or_else(|| KernelError::validation("work diary date overflow"))?;
    let sheet = workbook
        .sheet_by_name_mut(&sheet_name)
        .map_err(|error| PgReportingError::Workbook(error.to_string()))?;

    write_cell(sheet, 2, 3, format!("작성일자 : {}", dotted_date(date)));
    write_cell(
        sheet,
        2,
        5,
        format!(" ( {} ) 특  기  사  항", korean_month_day(date)),
    );
    write_cell(
        sheet,
        2,
        8,
        format!(" 전 일 진 행 업 무 ({})", korean_month_day(date)),
    );
    write_cell(
        sheet,
        6,
        8,
        format!("금 일 예 정 업 무 ({})", korean_month_day(next_date)),
    );
    write_cell(sheet, 2, 10, body.previous_results.clone());
    write_cell(sheet, 6, 10, body.today_plans.clone());

    for row in 15..=31 {
        write_cell(sheet, 2, row, "");
    }
    for (offset, entry) in body.urgent_actions.iter().take(17).enumerate() {
        let row = 15
            + u32::try_from(offset).map_err(|_| {
                PgReportingError::Workbook("too many urgent action rows".to_owned())
            })?;
        write_cell(
            sheet,
            2,
            row,
            format!(
                "▶ {} {}\n   1) 점검 : {}\n   2) 조치 : {}",
                entry.site_name, entry.management_no, entry.diagnosis, entry.action_taken
            ),
        );
    }

    let mut output = Vec::new();
    umya_spreadsheet::writer::xlsx::write_writer(&workbook, &mut output)
        .map_err(|error| PgReportingError::Workbook(error.to_string()))?;
    Ok(output)
}

fn write_cell(
    sheet: &mut umya_spreadsheet::Worksheet,
    column: u32,
    row: u32,
    value: impl Into<String>,
) {
    sheet.cell_mut((column, row)).set_value(value);
}

fn diary_results_text(rows: &[DailyStatusRow]) -> String {
    if rows.is_empty() {
        return "완료 업무 없음".to_owned();
    }
    rows.iter()
        .map(|row| {
            format!(
                "▶ {} {} {}",
                row.site_name,
                management_no_display(row.management_no.clone()).unwrap_or_default(),
                row.symptom
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn diary_plans_text(rows: &[DailyStatusRow]) -> String {
    if rows.is_empty() {
        return "예정 업무 없음".to_owned();
    }
    rows.iter()
        .map(|row| {
            let plan_text = row
                .result_note
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(&row.symptom);
            format!(
                "▶ {} {} {}",
                row.site_name,
                management_no_display(row.management_no.clone()).unwrap_or_default(),
                plan_text
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn audit_event(
    action: &'static str,
    actor: UserId,
    target_type: &'static str,
    target_id: uuid::Uuid,
    branch_id: Option<BranchId>,
    trace: TraceContext,
    occurred_at: Timestamp,
) -> Result<AuditEvent, PgReportingError> {
    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new(action)?,
        target_type,
        target_id.to_string(),
        trace,
        occurred_at,
    );
    Ok(if let Some(branch_id) = branch_id {
        event.with_branch(branch_id)
    } else {
        event
    })
}

fn single_branch(scope: &BranchScope) -> Option<BranchId> {
    match scope {
        BranchScope::All => None,
        BranchScope::Branches(branches) if branches.len() == 1 => branches.iter().next().copied(),
        BranchScope::Branches(_) => None,
    }
}

fn scope_key(scope: &BranchScope) -> String {
    match scope {
        BranchScope::All => "ALL".to_owned(),
        BranchScope::Branches(branches) => branches
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(","),
    }
}

fn management_no_display(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty()).map(|value| {
        if value.starts_with('#') {
            value
        } else {
            format!("#{value}")
        }
    })
}

fn priority_warning(priority: &str) -> String {
    match priority {
        "P1" => "Priority#1".to_owned(),
        "P2" => "Priority#2".to_owned(),
        "P3" => "Priority#3".to_owned(),
        "OUTSOURCE" => "OUTSOURCE".to_owned(),
        _ => String::new(),
    }
}

fn date_text(value: Option<Date>) -> String {
    value.map(iso_date).unwrap_or_default()
}

fn iso_date(date: Date) -> String {
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

fn dotted_date(date: Date) -> String {
    format!(
        "{:04}. {:02}. {:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

fn korean_month_day(date: Date) -> String {
    format!("{:02}월 {:02}일", u8::from(date.month()), date.day())
}

fn work_diary_sheet_name(date: Date) -> String {
    korean_month_day(date)
}
