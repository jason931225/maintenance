//! Identity application layer.
//!
//! Ports for external identity providers live here. Local accounts remain the
//! real launch identity implementation; Bitween enters later through this
//! application-layer seam only when a real adapter exists.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

mod org;

pub use org::{
    AccountStatus, BranchSummary, CreateBranchCommand, CreatePolicyAssignmentPreviewReceiptCommand,
    CreatePolicyRoleCommand, CreateRegionCommand, CreateUserCommand, DeactivateBranchCommand,
    DeactivateRegionCommand, DeactivateUserCommand, EmployeeLinkStatus,
    PolicyAssignmentPreviewReceiptSummary, PolicyAuditEventSummary, PolicyRoleAssignmentSummary,
    PolicyRoleCondition, PolicyRolePermission, PolicyRoleSummary, PolicyVersionSummary,
    RegionSummary, ReplacePolicyRoleAssignmentsCommand, UpdateBranchCommand,
    UpdatePolicyRoleCommand, UpdatePolicyRoleStatusCommand, UpdateRegionCommand,
    UpdateSelfProfileCommand, UpdateUserCommand, UserListQuery, UserPage, UserSummary,
    account_status_for, branch_audit_event, policy_role_assignment_audit_event,
    policy_role_audit_event, region_audit_event, user_audit_event,
};

use std::future::Future;
use std::pin::Pin;

use mnt_kernel_core::Timestamp;
use serde::{Deserialize, Serialize};
use time::Date;

/// Result type returned by the future Bitween identity provider seam.
pub type IdentityProviderResult<T> = Result<T, IdentityProviderError>;

/// Boxed async result used to keep [`IdentityProviderPort`] dyn-compatible
/// without introducing an adapter or async-trait dependency.
pub type IdentityProviderFuture<'a, T> =
    Pin<Box<dyn Future<Output = IdentityProviderResult<T>> + Send + 'a>>;

/// Cursor request for Bitween-owned employee and role data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRoleSyncRequest {
    pub tenant_id: String,
    pub changed_since: Option<Timestamp>,
    pub cursor: Option<String>,
    pub limit: u16,
}

/// Page of Bitween-owned employee and role data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRoleSyncPage {
    pub tenant_id: String,
    pub records: Vec<UserRoleSyncRecord>,
    pub next_cursor: Option<String>,
}

/// One Bitween employee identity row with role assignments.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRoleSyncRecord {
    pub tenant_id: String,
    pub employee_id: String,
    pub external_user_id: Option<String>,
    pub display_name: String,
    pub department_name: Option<String>,
    pub roles: Vec<ExternalRoleAssignment>,
    pub active: bool,
    pub synced_at: Option<Timestamp>,
}

/// One Bitween role assignment for an employee.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalRoleAssignment {
    pub role_code: String,
    pub branch_code: Option<String>,
    pub active: bool,
}

/// Attendance query against Bitween's attendance ownership boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttendanceReadRequest {
    pub tenant_id: String,
    pub employee_ids: Vec<String>,
    pub work_date: Date,
    pub cursor: Option<String>,
    pub limit: u16,
}

/// Page of Bitween attendance rows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttendancePage {
    pub tenant_id: String,
    pub records: Vec<AttendanceRecord>,
    pub next_cursor: Option<String>,
}

/// One Bitween attendance row for an employee.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttendanceRecord {
    pub tenant_id: String,
    pub employee_id: String,
    pub external_user_id: Option<String>,
    pub attendance_status: AttendanceStatus,
    pub observed_at: Timestamp,
}

/// Raw Bitween attendance value plus the normalized category this system can
/// consume without taking ownership of attendance/payroll semantics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttendanceStatus {
    pub raw: String,
    pub normalized: NormalizedAttendanceStatus,
}

/// Normalized attendance categories accepted at the identity seam.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum NormalizedAttendanceStatus {
    OnDuty,
    OffDuty,
    Break,
    Leave,
    Absent,
    Unknown,
}

/// Errors exposed by the Bitween identity-provider seam.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum IdentityProviderError {
    Unavailable(String),
    InvalidRequest(String),
    ContractViolation(String),
}

impl std::fmt::Display for IdentityProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(message) => write!(f, "identity provider unavailable: {message}"),
            Self::InvalidRequest(message) => write!(f, "invalid identity request: {message}"),
            Self::ContractViolation(message) => {
                write!(f, "identity provider contract violation: {message}")
            }
        }
    }
}

impl std::error::Error for IdentityProviderError {}

/// Port for the deferred Bitween identity and attendance integration.
///
/// Local accounts remain the production identity source until a real Bitween
/// adapter exists. This trait records the future contract only; ADR-0010
/// forbids mock adapters and UI affordances for the unfilled seam.
///
/// The Bitween contract preserves camelCase field names at the serialization
/// boundary, including `tenantId`, `employeeId`, `externalUserId`, and
/// `attendanceStatus`.
///
/// ```
/// use mnt_identity_application::IdentityProviderPort;
///
/// fn accepts_bitween_seam(_port: &dyn IdentityProviderPort) {}
/// ```
pub trait IdentityProviderPort: Send + Sync {
    fn sync_users_and_roles<'a>(
        &'a self,
        request: UserRoleSyncRequest,
    ) -> IdentityProviderFuture<'a, UserRoleSyncPage>;

    fn read_attendance<'a>(
        &'a self,
        request: AttendanceReadRequest,
    ) -> IdentityProviderFuture<'a, AttendancePage>;
}

#[cfg(test)]
mod identity_provider_port_contract_tests {
    use super::*;

    fn accepts_dyn_port(_port: &dyn IdentityProviderPort) {}

    #[test]
    fn identity_provider_port_is_object_safe() {
        let _: fn(&dyn IdentityProviderPort) = accepts_dyn_port;
    }

    #[test]
    fn user_role_sync_contract_carries_bitween_identity_fields() {
        let record = UserRoleSyncRecord {
            tenant_id: "tenant-seoul".to_owned(),
            employee_id: "E-1001".to_owned(),
            external_user_id: Some("bitween-user-1001".to_owned()),
            display_name: "Kim Mechanic".to_owned(),
            department_name: Some("Maintenance".to_owned()),
            roles: vec![ExternalRoleAssignment {
                role_code: "MECHANIC".to_owned(),
                branch_code: Some("SEOUL-01".to_owned()),
                active: true,
            }],
            active: true,
            synced_at: None,
        };

        assert_eq!(record.tenant_id, "tenant-seoul");
        assert_eq!(record.employee_id, "E-1001");
        assert_eq!(
            record.external_user_id.as_deref(),
            Some("bitween-user-1001")
        );
        assert_eq!(record.roles[0].role_code, "MECHANIC");
    }

    #[test]
    fn bitween_contract_serializes_required_fields_as_camel_case() {
        let record = UserRoleSyncRecord {
            tenant_id: "tenant-seoul".to_owned(),
            employee_id: "E-1001".to_owned(),
            external_user_id: Some("bitween-user-1001".to_owned()),
            display_name: "Kim Mechanic".to_owned(),
            department_name: Some("Maintenance".to_owned()),
            roles: vec![ExternalRoleAssignment {
                role_code: "MECHANIC".to_owned(),
                branch_code: Some("SEOUL-01".to_owned()),
                active: true,
            }],
            active: true,
            synced_at: None,
        };
        let attendance = AttendanceRecord {
            tenant_id: "tenant-seoul".to_owned(),
            employee_id: "E-1001".to_owned(),
            external_user_id: Some("bitween-user-1001".to_owned()),
            attendance_status: AttendanceStatus {
                raw: "ON_DUTY".to_owned(),
                normalized: NormalizedAttendanceStatus::OnDuty,
            },
            observed_at: time::OffsetDateTime::UNIX_EPOCH,
        };

        let record_json = serde_json::to_value(&record).unwrap();
        assert!(record_json.get("tenantId").is_some());
        assert!(record_json.get("employeeId").is_some());
        assert!(record_json.get("externalUserId").is_some());
        assert!(record_json.get("tenant_id").is_none());
        assert!(record_json.get("employee_id").is_none());
        assert!(record_json.get("external_user_id").is_none());

        let attendance_json = serde_json::to_value(&attendance).unwrap();
        assert!(attendance_json.get("tenantId").is_some());
        assert!(attendance_json.get("employeeId").is_some());
        assert!(attendance_json.get("externalUserId").is_some());
        assert!(attendance_json.get("attendanceStatus").is_some());
        assert!(attendance_json.get("attendance_status").is_none());
    }

    #[test]
    fn attendance_contract_carries_status_and_employee_identity() {
        let attendance = AttendanceRecord {
            tenant_id: "tenant-seoul".to_owned(),
            employee_id: "E-1001".to_owned(),
            external_user_id: Some("bitween-user-1001".to_owned()),
            attendance_status: AttendanceStatus {
                raw: "ON_DUTY".to_owned(),
                normalized: NormalizedAttendanceStatus::OnDuty,
            },
            observed_at: time::OffsetDateTime::UNIX_EPOCH,
        };

        assert_eq!(attendance.attendance_status.raw, "ON_DUTY");
        assert_eq!(
            attendance.attendance_status.normalized,
            NormalizedAttendanceStatus::OnDuty
        );
    }
}
