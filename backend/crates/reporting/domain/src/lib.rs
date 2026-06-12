//! Pure reporting/KPI domain.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::collections::BTreeMap;

use mnt_kernel_core::{BranchId, RegionId, Timestamp, UserId};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Period {
    pub start: Timestamp,
    pub end: Timestamp,
}

impl Period {
    #[must_use]
    pub fn contains(self, value: Timestamp) -> bool {
        value >= self.start && value < self.end
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum KpiScope {
    Company,
    Region(RegionId),
    Branch(BranchId),
    Technician(UserId),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum KpiRollupScope {
    Company,
    Region(RegionId),
    Branch(BranchId),
    Technician(UserId),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KpiMetric {
    CompletedCount,
    AverageResponseSpeed,
    CompletionDurationAndDueCompliance,
    RevisitRate,
    DelayRateAndReasonDistribution,
    InspectionPlanCompletionRate,
    P1AcceptanceRate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnavailableMetric {
    pub metric: KpiMetric,
    pub source_domain: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KpiReport {
    pub period: Period,
    pub requested_scope: KpiScope,
    pub rollups: Vec<KpiRollup>,
    pub unavailable_metrics: Vec<UnavailableMetric>,
}

impl KpiReport {
    #[must_use]
    pub fn rollup(&self, scope: &KpiRollupScope) -> Option<&KpiRollup> {
        self.rollups.iter().find(|rollup| &rollup.scope == scope)
    }

    #[must_use]
    pub fn unavailable_metric(&self, metric: KpiMetric) -> Option<&UnavailableMetric> {
        self.unavailable_metrics
            .iter()
            .find(|unavailable| unavailable.metric == metric)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KpiRollup {
    pub scope: KpiRollupScope,
    pub approved_report_count: u32,
    pub completed_count: u32,
    pub weighted_completed_points: u32,
    pub inspection_schedule_due_count: u32,
    pub inspection_schedule_completed_count: u32,
    pub inspection_plan_completion_bps: Option<u32>,
    pub average_response_seconds: Option<i64>,
    pub average_completion_seconds: Option<i64>,
    pub target_due_compliance_bps: Option<u32>,
    pub revisit_rate_bps: u32,
    pub delay_rate_bps: u32,
    pub delay_reason_distribution: BTreeMap<String, u32>,
    #[serde(default, skip_serializing)]
    pub work_order_ids: Vec<uuid::Uuid>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KpiInputRecord {
    pub work_order_id: uuid::Uuid,
    pub branch_id: BranchId,
    pub region_id: RegionId,
    pub technician_id: Option<UserId>,
    pub status: String,
    pub priority: String,
    pub result_type: String,
    pub delay_reason: Option<String>,
    pub created_at: Timestamp,
    pub first_in_progress_at: Option<Timestamp>,
    pub approved_at: Timestamp,
    pub target_due_at: Option<Timestamp>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KpiInspectionRecord {
    pub schedule_id: uuid::Uuid,
    pub branch_id: BranchId,
    pub region_id: RegionId,
    pub technician_id: UserId,
    pub completed: bool,
}

#[must_use]
pub fn calculate_kpi_report(
    period: Period,
    requested_scope: KpiScope,
    records: &[KpiInputRecord],
    inspection_records: &[KpiInspectionRecord],
    unavailable_metrics: Vec<UnavailableMetric>,
) -> KpiReport {
    let mut builders = BTreeMap::<KpiRollupScope, KpiRollupBuilder>::new();
    for record in records {
        add_record(&mut builders, KpiRollupScope::Company, record);
        add_record(
            &mut builders,
            KpiRollupScope::Region(record.region_id),
            record,
        );
        add_record(
            &mut builders,
            KpiRollupScope::Branch(record.branch_id),
            record,
        );
        if let Some(technician_id) = record.technician_id {
            add_record(
                &mut builders,
                KpiRollupScope::Technician(technician_id),
                record,
            );
        }
    }
    for record in inspection_records {
        add_inspection_record(&mut builders, KpiRollupScope::Company, record);
        add_inspection_record(
            &mut builders,
            KpiRollupScope::Region(record.region_id),
            record,
        );
        add_inspection_record(
            &mut builders,
            KpiRollupScope::Branch(record.branch_id),
            record,
        );
        add_inspection_record(
            &mut builders,
            KpiRollupScope::Technician(record.technician_id),
            record,
        );
    }

    KpiReport {
        period,
        requested_scope,
        rollups: builders
            .into_iter()
            .map(|(scope, builder)| builder.finish(scope))
            .collect(),
        unavailable_metrics,
    }
}

fn add_record(
    builders: &mut BTreeMap<KpiRollupScope, KpiRollupBuilder>,
    scope: KpiRollupScope,
    record: &KpiInputRecord,
) {
    builders.entry(scope).or_default().push(record);
}

fn add_inspection_record(
    builders: &mut BTreeMap<KpiRollupScope, KpiRollupBuilder>,
    scope: KpiRollupScope,
    record: &KpiInspectionRecord,
) {
    builders.entry(scope).or_default().push_inspection(record);
}

#[derive(Debug, Default)]
struct KpiRollupBuilder {
    approved_report_count: u32,
    completed_count: u32,
    weighted_completed_points: u32,
    response_seconds_total: i128,
    response_count: u32,
    completion_seconds_total: i128,
    completion_count: u32,
    target_due_count: u32,
    target_due_compliant_count: u32,
    inspection_schedule_due_count: u32,
    inspection_schedule_completed_count: u32,
    revisit_count: u32,
    delay_count: u32,
    delay_reason_distribution: BTreeMap<String, u32>,
    work_order_ids: Vec<uuid::Uuid>,
}

impl KpiRollupBuilder {
    fn push(&mut self, record: &KpiInputRecord) {
        self.approved_report_count += 1;
        self.work_order_ids.push(record.work_order_id);

        if let Some(first_start) = record.first_in_progress_at
            && first_start >= record.created_at
        {
            self.response_seconds_total +=
                (first_start - record.created_at).whole_seconds() as i128;
            self.response_count += 1;
        }

        if record.result_type == "REVISIT_REQUIRED" {
            self.revisit_count += 1;
        }

        if let Some(reason) = record
            .delay_reason
            .as_ref()
            .filter(|reason| !reason.is_empty())
        {
            self.delay_count += 1;
            *self
                .delay_reason_distribution
                .entry(reason.clone())
                .or_insert(0) += 1;
        }

        if !is_completed(record) {
            return;
        }

        self.completed_count += 1;
        self.weighted_completed_points += priority_weight(&record.priority);
        if record.approved_at >= record.created_at {
            self.completion_seconds_total +=
                (record.approved_at - record.created_at).whole_seconds() as i128;
            self.completion_count += 1;
        }
        if let Some(target_due_at) = record.target_due_at {
            self.target_due_count += 1;
            if record.approved_at <= target_due_at {
                self.target_due_compliant_count += 1;
            }
        }
    }

    fn push_inspection(&mut self, record: &KpiInspectionRecord) {
        self.inspection_schedule_due_count += 1;
        if record.completed {
            self.inspection_schedule_completed_count += 1;
        }
    }

    fn finish(mut self, scope: KpiRollupScope) -> KpiRollup {
        self.work_order_ids.sort_unstable();
        KpiRollup {
            scope,
            approved_report_count: self.approved_report_count,
            completed_count: self.completed_count,
            weighted_completed_points: self.weighted_completed_points,
            inspection_schedule_due_count: self.inspection_schedule_due_count,
            inspection_schedule_completed_count: self.inspection_schedule_completed_count,
            inspection_plan_completion_bps: rate_bps(
                self.inspection_schedule_completed_count,
                self.inspection_schedule_due_count,
            ),
            average_response_seconds: average_i64(self.response_seconds_total, self.response_count),
            average_completion_seconds: average_i64(
                self.completion_seconds_total,
                self.completion_count,
            ),
            target_due_compliance_bps: rate_bps(
                self.target_due_compliant_count,
                self.target_due_count,
            ),
            revisit_rate_bps: rate_bps(self.revisit_count, self.approved_report_count).unwrap_or(0),
            delay_rate_bps: rate_bps(self.delay_count, self.approved_report_count).unwrap_or(0),
            delay_reason_distribution: self.delay_reason_distribution,
            work_order_ids: self.work_order_ids,
        }
    }
}

fn is_completed(record: &KpiInputRecord) -> bool {
    record.status == "FINAL_COMPLETED"
}

fn priority_weight(priority: &str) -> u32 {
    match priority {
        "P1" => 3,
        "P2" => 2,
        "P3" => 1,
        _ => 0,
    }
}

fn average_i64(total: i128, count: u32) -> Option<i64> {
    if count == 0 {
        return None;
    }
    let count = i128::from(count);
    i64::try_from(total / count).ok()
}

fn rate_bps(numerator: u32, denominator: u32) -> Option<u32> {
    numerator.saturating_mul(10_000).checked_div(denominator)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExportSourceNote {
    pub source_domain: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DailyStatusReport {
    pub date: time::Date,
    pub results: Vec<DailyStatusRow>,
    pub plans: Vec<DailyStatusRow>,
    pub pending_backlog: Vec<DailyStatusRow>,
    pub periodic_inspections: Vec<PeriodicInspectionRow>,
    pub source_notes: Vec<ExportSourceNote>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DailyStatusRow {
    pub request_date: Option<time::Date>,
    pub site_name: String,
    pub management_no: Option<String>,
    pub model: Option<String>,
    pub vin: Option<String>,
    pub symptom: String,
    pub mechanic_name: Option<String>,
    pub scheduled_date: Option<time::Date>,
    pub completed_date: Option<time::Date>,
    pub result_note: Option<String>,
    pub priority: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeriodicInspectionRow {
    pub site_name: String,
    pub vehicle_no: Option<String>,
    pub management_no: Option<String>,
    pub model: Option<String>,
    pub serial_no: Option<String>,
    pub issue: String,
    pub inspection_period: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkDiaryBody {
    pub previous_results: String,
    pub today_plans: String,
    pub urgent_actions: Vec<WorkDiaryActionEntry>,
    pub source_notes: Vec<ExportSourceNote>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkDiaryActionEntry {
    pub site_name: String,
    pub management_no: String,
    pub diagnosis: String,
    pub action_taken: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WorkDiaryStatus {
    Draft,
    Confirmed,
}

impl WorkDiaryStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "DRAFT",
            Self::Confirmed => "CONFIRMED",
        }
    }

    pub fn from_db_str(value: &str) -> Result<Self, mnt_kernel_core::KernelError> {
        match value {
            "DRAFT" => Ok(Self::Draft),
            "CONFIRMED" => Ok(Self::Confirmed),
            other => Err(mnt_kernel_core::KernelError::validation(format!(
                "unknown work diary status {other:?}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkDiaryDraft {
    pub id: uuid::Uuid,
    pub date: time::Date,
    pub status: WorkDiaryStatus,
    pub body: WorkDiaryBody,
    pub confirmed_by: Option<UserId>,
    pub confirmed_at: Option<Timestamp>,
}
