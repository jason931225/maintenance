//! Pure reporting/KPI domain.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::collections::BTreeMap;

use mnt_kernel_core::{BranchId, RegionId, Timestamp, UserId};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Period {
    #[serde(with = "time::serde::rfc3339")]
    pub start: Timestamp,
    #[serde(with = "time::serde::rfc3339")]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KpiWorkOrderStatus {
    FinalCompleted,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KpiPriorityLevel {
    P1,
    P2,
    P3,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KpiWorkResultType {
    RevisitRequired,
    Other,
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
    /// Human-readable name for the scope (region/branch/mechanic), resolved by
    /// the adapter via a same-org lookup after the pure aggregation runs. `None`
    /// for the company-wide scope (which has no id) or a since-deleted
    /// region/branch/user; the web renders it through `safeLabel` so a missing
    /// name never leaks the UUID. `#[serde(default)]` keeps the pure domain
    /// calculation (which leaves it `None`) and older payloads valid.
    #[serde(default)]
    pub scope_display_name: Option<String>,
    pub approved_report_count: u32,
    pub completed_count: u32,
    pub weighted_completed_points: u32,
    pub inspection_schedule_due_count: u32,
    pub inspection_schedule_completed_count: u32,
    pub inspection_plan_completion_bps: Option<u32>,
    pub p1_dispatch_count: u32,
    pub p1_accepted_count: u32,
    pub p1_acceptance_bps: Option<u32>,
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
    pub status: KpiWorkOrderStatus,
    pub priority: KpiPriorityLevel,
    pub result_type: KpiWorkResultType,
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

/// One P1 emergency dispatch broadcast whose accept window opened within the
/// reporting period. `accepted` is true when a mechanic accepted the broadcast
/// (the dispatch reached `AUTO_ASSIGNED`, or at least one target responded
/// `ACCEPT`) — i.e. the broadcast was answered without a manager force-assign.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KpiP1Record {
    pub dispatch_id: uuid::Uuid,
    pub branch_id: BranchId,
    pub region_id: RegionId,
    pub technician_id: Option<UserId>,
    pub accepted: bool,
}

#[must_use]
pub fn calculate_kpi_report(
    period: Period,
    requested_scope: KpiScope,
    records: &[KpiInputRecord],
    inspection_records: &[KpiInspectionRecord],
    p1_records: &[KpiP1Record],
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
    for record in p1_records {
        add_p1_record(&mut builders, KpiRollupScope::Company, record);
        add_p1_record(
            &mut builders,
            KpiRollupScope::Region(record.region_id),
            record,
        );
        add_p1_record(
            &mut builders,
            KpiRollupScope::Branch(record.branch_id),
            record,
        );
        if let Some(technician_id) = record.technician_id {
            add_p1_record(
                &mut builders,
                KpiRollupScope::Technician(technician_id),
                record,
            );
        }
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

fn add_p1_record(
    builders: &mut BTreeMap<KpiRollupScope, KpiRollupBuilder>,
    scope: KpiRollupScope,
    record: &KpiP1Record,
) {
    builders.entry(scope).or_default().push_p1(record);
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
    p1_dispatch_count: u32,
    p1_accepted_count: u32,
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

        if record.result_type == KpiWorkResultType::RevisitRequired {
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
        self.weighted_completed_points += priority_weight(record.priority);
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

    fn push_p1(&mut self, record: &KpiP1Record) {
        self.p1_dispatch_count += 1;
        if record.accepted {
            self.p1_accepted_count += 1;
        }
    }

    fn finish(mut self, scope: KpiRollupScope) -> KpiRollup {
        self.work_order_ids.sort_unstable();
        KpiRollup {
            scope,
            // Names are resolved by the adapter post-pass (DB lookup); the pure
            // domain calculation has no access to region/branch/user names.
            scope_display_name: None,
            approved_report_count: self.approved_report_count,
            completed_count: self.completed_count,
            weighted_completed_points: self.weighted_completed_points,
            inspection_schedule_due_count: self.inspection_schedule_due_count,
            inspection_schedule_completed_count: self.inspection_schedule_completed_count,
            inspection_plan_completion_bps: rate_bps(
                self.inspection_schedule_completed_count,
                self.inspection_schedule_due_count,
            ),
            p1_dispatch_count: self.p1_dispatch_count,
            p1_accepted_count: self.p1_accepted_count,
            p1_acceptance_bps: rate_bps(self.p1_accepted_count, self.p1_dispatch_count),
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
    record.status == KpiWorkOrderStatus::FinalCompleted
}

const fn priority_weight(priority: KpiPriorityLevel) -> u32 {
    match priority {
        KpiPriorityLevel::P1 => 3,
        KpiPriorityLevel::P2 => 2,
        KpiPriorityLevel::P3 => 1,
        KpiPriorityLevel::Other => 0,
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

// ---------------------------------------------------------------------------
// Operational dashboard (per-tenant ops console)
// ---------------------------------------------------------------------------

/// One stage of the work-order funnel with its current open count.
///
/// `접수`/RECEIVED → `배정`/ASSIGNED → `진행`/IN_PROGRESS → `완료`/COMPLETED.
/// Counts are point-in-time (current `work_orders.status`), org-scoped by RLS.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpsFunnel {
    /// RECEIVED + UNASSIGNED (intake, not yet assigned).
    pub received: u32,
    /// ASSIGNED (a mechanic is on it, work not started).
    pub assigned: u32,
    /// IN_PROGRESS + REPORT_SUBMITTED + ADMIN_REVIEW (active work).
    pub in_progress: u32,
    /// FINAL_COMPLETED (terminal success).
    pub completed: u32,
}

/// Distribution of equipment by lifecycle status (Korean enum values).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpsEquipmentStatus {
    /// 임대 — rented out.
    pub rented: u32,
    /// 예비 — spare / reserve.
    pub spare: u32,
    /// 폐기 — scrapped.
    pub scrapped: u32,
    /// 대체 — replacement unit.
    pub replacement: u32,
    /// 매각 — sold.
    pub sold: u32,
}

/// One mechanic's current active-assignment load (utilization top-N row).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpsMechanicLoad {
    pub mechanic_id: uuid::Uuid,
    pub display_name: String,
    /// Count of assignments on work orders that are not yet terminal.
    pub active_assignments: u32,
}

/// Point-in-time operational rollup for one tenant (org-scoped under RLS).
///
/// All counts are computed from the requesting tenant's data only — every read
/// runs inside `with_org_conn(current_org())`, so a second org's rows are never
/// visible. `aging_hours` is the threshold used for `aging_work_orders`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpsSummary {
    pub funnel: OpsFunnel,
    /// Threshold (hours) past which an unresolved work order counts as aging.
    pub aging_hours: u32,
    /// Open work orders older than `aging_hours` with no terminal status.
    pub aging_work_orders: u32,
    /// P1 dispatches still BROADCASTING whose accept window has expired.
    pub sla_breached: u32,
    /// P1 dispatches still BROADCASTING whose accept window expires soon.
    pub sla_at_risk: u32,
    /// Top-N mechanics by current active-assignment count.
    pub mechanic_load: Vec<OpsMechanicLoad>,
    pub equipment_status: OpsEquipmentStatus,
    /// Equipment substitutions (대차) currently active (not yet returned).
    pub active_substitutions: u32,
    /// Work-order approval steps awaiting a decision (PENDING).
    pub pending_approvals: u32,
    /// Support tickets not yet resolved/closed (OPEN + IN_PROGRESS + ON_HOLD).
    pub open_support_tickets: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    fn id(value: u128) -> uuid::Uuid {
        uuid::Uuid::from_u128(value)
    }

    fn record(
        work_order_id: uuid::Uuid,
        status: KpiWorkOrderStatus,
        priority: KpiPriorityLevel,
        result_type: KpiWorkResultType,
    ) -> KpiInputRecord {
        KpiInputRecord {
            work_order_id,
            branch_id: BranchId::from_uuid(id(0xb1)),
            region_id: RegionId::from_uuid(id(0xc1)),
            technician_id: Some(UserId::from_uuid(id(0xd1))),
            status,
            priority,
            result_type,
            delay_reason: None,
            created_at: datetime!(2026-07-01 09:00 UTC),
            first_in_progress_at: Some(datetime!(2026-07-01 10:00 UTC)),
            approved_at: datetime!(2026-07-01 12:00 UTC),
            target_due_at: Some(datetime!(2026-07-01 13:00 UTC)),
        }
    }

    #[test]
    fn kpi_rollups_use_typed_work_order_values_without_changing_known_aggregates() {
        let period = Period {
            start: datetime!(2026-07-01 00:00 UTC),
            end: datetime!(2026-07-02 00:00 UTC),
        };
        let records = vec![
            record(
                id(1),
                KpiWorkOrderStatus::FinalCompleted,
                KpiPriorityLevel::P1,
                KpiWorkResultType::Other,
            ),
            record(
                id(2),
                KpiWorkOrderStatus::FinalCompleted,
                KpiPriorityLevel::P2,
                KpiWorkResultType::Other,
            ),
            record(
                id(3),
                KpiWorkOrderStatus::Other,
                KpiPriorityLevel::P3,
                KpiWorkResultType::Other,
            ),
            record(
                id(4),
                KpiWorkOrderStatus::FinalCompleted,
                KpiPriorityLevel::P3,
                KpiWorkResultType::RevisitRequired,
            ),
        ];

        let report =
            calculate_kpi_report(period, KpiScope::Company, &records, &[], &[], Vec::new());
        let company = report.rollup(&KpiRollupScope::Company).unwrap();

        assert_eq!(company.approved_report_count, 4);
        assert_eq!(company.completed_count, 3);
        assert_eq!(company.weighted_completed_points, 6);
        assert_eq!(company.revisit_rate_bps, 2_500);
        assert_eq!(company.target_due_compliance_bps, Some(10_000));
    }
}
