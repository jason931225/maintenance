//! Postgres reporting adapter.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_kernel_core::{BranchId, BranchScope, KernelError, RegionId, UserId};
use mnt_reporting_application::{KpiQuery, KpiQueryError, KpiQueryPort};
use mnt_reporting_domain::{
    KpiInputRecord, KpiMetric, KpiReport, KpiScope, UnavailableMetric, calculate_kpi_report,
};
use sqlx::{PgPool, Postgres, QueryBuilder, Row};

#[derive(Debug, Clone)]
pub struct PgKpiRepository {
    pool: PgPool,
}

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
}

impl KpiQueryPort for PgKpiRepository {
    async fn query_kpis(&self, query: KpiQuery) -> Result<KpiReport, KpiQueryError> {
        self.query_kpis_inner(query).await
    }
}

fn push_branch_scope_filter(builder: &mut QueryBuilder<Postgres>, branch_scope: &BranchScope) {
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
            builder.push("w.branch_id = ANY(");
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
