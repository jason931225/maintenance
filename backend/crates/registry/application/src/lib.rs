//! Registry application layer.
//!
//! Use-case DTOs and audit event builders live here. Concrete workbook and
//! database adapters remain in outer crates.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, BranchScope, EquipmentId, EquipmentSubstitutionId,
    KernelError, Timestamp, TraceContext, UserId,
};
use mnt_registry_domain::{EquipmentNo, EquipmentStatus, MoneyWon, SubstituteMatchKind, Ton};
use time::Date;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportSheet {
    Master,
    Reserve,
}

impl ImportSheet {
    #[must_use]
    pub const fn workbook_name(self) -> &'static str {
        match self {
            Self::Master => "K&L 지게차 Master list",
            Self::Reserve => "예비 및 여유차량",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct MasterListEquipment {
    pub source_sheet: ImportSheet,
    pub source_row: u32,
    pub equipment_no: EquipmentNo,
    pub management_no: Option<String>,
    pub manufacturer_code: String,
    pub kind_code: String,
    pub power_code: String,
    pub power_label: Option<String>,
    pub customer_name: String,
    pub site_name: String,
    pub status: EquipmentStatus,
    pub manager_name: Option<String>,
    pub placement_location: Option<String>,
    pub placement_no: Option<String>,
    pub operation_shift: Option<String>,
    pub specification: String,
    pub ton: Ton,
    pub maker: Option<String>,
    pub model: Option<String>,
    pub vin: Option<String>,
    pub year: Option<Date>,
    pub hours: Option<i64>,
    pub vehicle_registration_no: Option<String>,
    pub insured: Option<bool>,
    pub insurer: Option<String>,
    pub policy_holder: Option<String>,
    pub insured_party: Option<String>,
    pub asset_owner: Option<String>,
    pub asset_registered_on: Option<Date>,
    pub rental_started_on: Option<Date>,
    pub rental_fee: Option<MoneyWon>,
    pub vehicle_value: Option<MoneyWon>,
    pub residual_value: Option<MoneyWon>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RegistryRowError {
    pub sheet: String,
    pub row: u32,
    pub message: String,
}

impl RegistryRowError {
    #[must_use]
    pub fn new(sheet: impl Into<String>, row: u32, message: impl Into<String>) -> Self {
        Self {
            sheet: sheet.into(),
            row,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ParsedMasterList {
    pub input_rows: usize,
    pub prefix_checked_rows: usize,
    pub equipment: Vec<MasterListEquipment>,
    pub errors: Vec<RegistryRowError>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RegistryImportReport {
    pub input_rows: usize,
    pub equipment_count: usize,
    pub added: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub orphaned: usize,
    pub errors: Vec<RegistryRowError>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SubstituteSearch {
    pub equipment_id: EquipmentId,
    pub branch_scope: BranchScope,
    pub include_all_branches: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SubstituteCandidate {
    pub equipment_id: EquipmentId,
    pub branch_id: BranchId,
    pub equipment_no: EquipmentNo,
    pub management_no: Option<String>,
    pub model: Option<String>,
    pub status: EquipmentStatus,
    pub specification: String,
    pub ton: Ton,
    pub power_code: String,
    pub power_label: Option<String>,
    pub customer_name: String,
    pub site_name: String,
    pub placement_location: Option<String>,
    pub match_kind: SubstituteMatchKind,
    pub ton_delta_milli: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SubstituteAssignmentCommand {
    pub actor: UserId,
    pub source_equipment_id: EquipmentId,
    pub substitute_equipment_id: EquipmentId,
    pub assigned_to: Option<UserId>,
    pub assignment_location: String,
    pub trace: TraceContext,
    pub assigned_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SubstituteReturnCommand {
    pub actor: UserId,
    pub substitution_id: EquipmentSubstitutionId,
    pub trace: TraceContext,
    pub returned_at: Timestamp,
    pub return_note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SubstituteAssignment {
    pub id: EquipmentSubstitutionId,
    pub branch_id: BranchId,
    pub source_equipment_id: EquipmentId,
    pub substitute_equipment_id: EquipmentId,
    pub assigned_by: UserId,
    pub assigned_to: Option<UserId>,
    pub assignment_location: String,
    pub assigned_at: Timestamp,
    pub returned_by: Option<UserId>,
    pub returned_at: Option<Timestamp>,
    pub return_note: Option<String>,
}

pub fn registry_import_audit_event(
    actor: Option<UserId>,
    branch_id: BranchId,
    trace: TraceContext,
    occurred_at: Timestamp,
    source_name: &str,
    input_rows: usize,
    equipment_count: usize,
) -> Result<AuditEvent, KernelError> {
    let after = serde_json::json!({
        "source": source_name,
        "input_rows": input_rows,
        "equipment_count": equipment_count,
    });

    Ok(AuditEvent::new(
        actor,
        AuditAction::new("registry.import")?,
        "registry_import",
        source_name,
        trace,
        occurred_at,
    )
    .with_branch(branch_id)
    .with_snapshots(None, Some(after)))
}

pub fn substitute_assign_audit_event(
    command: &SubstituteAssignmentCommand,
    branch_id: BranchId,
    substitution_id: EquipmentSubstitutionId,
) -> Result<AuditEvent, KernelError> {
    let after = serde_json::json!({
        "id": substitution_id,
        "source_equipment_id": command.source_equipment_id,
        "substitute_equipment_id": command.substitute_equipment_id,
        "assigned_to": command.assigned_to,
        "assignment_location": command.assignment_location,
        "assigned_at": command.assigned_at,
    });

    Ok(AuditEvent::new(
        Some(command.actor),
        AuditAction::new("equipment.substitute.assign")?,
        "equipment_substitution",
        substitution_id.to_string(),
        command.trace.clone(),
        command.assigned_at,
    )
    .with_branch(branch_id)
    .with_snapshots(None, Some(after)))
}

pub fn substitute_return_audit_event(
    command: &SubstituteReturnCommand,
    before: &SubstituteAssignment,
) -> Result<AuditEvent, KernelError> {
    let before_snap = serde_json::json!({
        "id": before.id,
        "source_equipment_id": before.source_equipment_id,
        "substitute_equipment_id": before.substitute_equipment_id,
        "assigned_to": before.assigned_to,
        "assignment_location": before.assignment_location,
        "assigned_at": before.assigned_at,
        "returned_at": before.returned_at,
    });
    let after = serde_json::json!({
        "id": before.id,
        "returned_by": command.actor,
        "returned_at": command.returned_at,
        "return_note": command.return_note,
    });

    Ok(AuditEvent::new(
        Some(command.actor),
        AuditAction::new("equipment.substitute.return")?,
        "equipment_substitution",
        before.id.to_string(),
        command.trace.clone(),
        command.returned_at,
    )
    .with_branch(before.branch_id)
    .with_snapshots(Some(before_snap), Some(after)))
}
