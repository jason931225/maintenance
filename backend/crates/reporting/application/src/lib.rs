//! Reporting application layer.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::future::Future;

use mnt_kernel_core::{BranchScope, KernelError, Timestamp, TraceContext, UserId};
pub use mnt_reporting_domain::{
    DailyStatusReport, DailyStatusRow, ExportSourceNote, KpiMetric, KpiReport, KpiRollup,
    KpiRollupScope, KpiScope, OpsEquipmentStatus, OpsFunnel, OpsMechanicLoad, OpsSummary, Period,
    PeriodicInspectionRow, UnavailableMetric, WorkDiaryActionEntry, WorkDiaryBody, WorkDiaryDraft,
    WorkDiaryStatus,
};
use time::Date;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KpiQuery {
    pub period: Period,
    pub scope: KpiScope,
    pub branch_scope: BranchScope,
}

#[derive(Debug, thiserror::Error)]
pub enum KpiQueryError {
    #[error(transparent)]
    Kernel(#[from] KernelError),

    #[error("database error: {0}")]
    Database(String),
}

pub trait KpiQueryPort {
    fn query_kpis(
        &self,
        query: KpiQuery,
    ) -> impl Future<Output = Result<KpiReport, KpiQueryError>> + Send + '_;
}

/// Per-tenant operational dashboard query.
///
/// `aging_hours` is the threshold past which an unresolved work order is counted
/// as aging; `at_risk_minutes` is the lead time before a P1 accept-window
/// deadline at which a dispatch is flagged at-risk; `top_mechanics` caps the
/// utilization list. All reads run org-scoped under RLS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpsSummaryQuery {
    pub aging_hours: u32,
    pub at_risk_minutes: u32,
    pub top_mechanics: u32,
}

pub trait OpsSummaryPort {
    fn ops_summary(
        &self,
        query: OpsSummaryQuery,
    ) -> impl Future<Output = Result<OpsSummary, KpiQueryError>> + Send + '_;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportingExportQuery {
    pub actor: UserId,
    pub date: Date,
    pub branch_scope: BranchScope,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkDiaryQuery {
    pub actor: UserId,
    pub date: Date,
    pub branch_scope: BranchScope,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkDiaryUpdateCommand {
    pub actor: UserId,
    pub date: Date,
    pub branch_scope: BranchScope,
    pub body: WorkDiaryBody,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkDiaryConfirmCommand {
    pub actor: UserId,
    pub date: Date,
    pub branch_scope: BranchScope,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportedWorkbook {
    pub file_name: String,
    pub content_type: &'static str,
    pub bytes: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
pub enum ReportingExportError {
    #[error(transparent)]
    Kernel(#[from] KernelError),

    #[error("database error: {0}")]
    Database(String),

    #[error("workbook error: {0}")]
    Workbook(String),
}

pub trait ReportingExportPort {
    fn export_daily_status(
        &self,
        query: ReportingExportQuery,
    ) -> impl Future<Output = Result<ExportedWorkbook, ReportingExportError>> + Send + '_;

    fn export_work_diary(
        &self,
        query: ReportingExportQuery,
    ) -> impl Future<Output = Result<ExportedWorkbook, ReportingExportError>> + Send + '_;
}

pub trait WorkDiaryDraftPort {
    fn get_or_generate_work_diary(
        &self,
        query: WorkDiaryQuery,
    ) -> impl Future<Output = Result<WorkDiaryDraft, ReportingExportError>> + Send + '_;

    fn update_work_diary(
        &self,
        command: WorkDiaryUpdateCommand,
    ) -> impl Future<Output = Result<WorkDiaryDraft, ReportingExportError>> + Send + '_;

    fn confirm_work_diary(
        &self,
        command: WorkDiaryConfirmCommand,
    ) -> impl Future<Output = Result<WorkDiaryDraft, ReportingExportError>> + Send + '_;
}
