//! Pure support-ticket domain: status FSM and priority→SLA mapping.
//!
//! Kept strictly separate from the 16-state work-order FSM and the P1 dispatch
//! FSM. A support ticket is a help-desk request (internal staff or external
//! customer), not a 정비 job. No I/O lives here — only data and transition
//! rules, exercised by unit tests.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_kernel_core::{KernelError, Timestamp, Transition, TransitionError};
use serde::{Deserialize, Serialize};
use time::Duration;

/// Ticket lifecycle:
///
/// ```text
/// OPEN ──► IN_PROGRESS ──► RESOLVED ──► CLOSED
///             ▲   │            │
///             │   ▼            │ (reopen)
///             └ ON_HOLD        ▼
///                          IN_PROGRESS
/// ```
///
/// Valid edges:
///   * OPEN        → IN_PROGRESS
///   * IN_PROGRESS → ON_HOLD | RESOLVED
///   * ON_HOLD     → IN_PROGRESS
///   * RESOLVED    → CLOSED | IN_PROGRESS (reopen)
///   * CLOSED      → (terminal)
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TicketStatus {
    Open,
    InProgress,
    OnHold,
    Resolved,
    Closed,
}

impl TicketStatus {
    #[must_use]
    pub const fn as_db_str(self) -> &'static str {
        match self {
            Self::Open => "OPEN",
            Self::InProgress => "IN_PROGRESS",
            Self::OnHold => "ON_HOLD",
            Self::Resolved => "RESOLVED",
            Self::Closed => "CLOSED",
        }
    }

    pub fn from_db_str(value: &str) -> Result<Self, KernelError> {
        match value {
            "OPEN" => Ok(Self::Open),
            "IN_PROGRESS" => Ok(Self::InProgress),
            "ON_HOLD" => Ok(Self::OnHold),
            "RESOLVED" => Ok(Self::Resolved),
            "CLOSED" => Ok(Self::Closed),
            other => Err(KernelError::validation(format!(
                "unknown support ticket status {other:?}"
            ))),
        }
    }

    /// Whether a direct transition `self → to` is permitted by the FSM.
    #[must_use]
    pub const fn can_transition_to(self, to: Self) -> bool {
        matches!(
            (self, to),
            (Self::Open, Self::InProgress)
                | (Self::InProgress, Self::OnHold)
                | (Self::InProgress, Self::Resolved)
                | (Self::OnHold, Self::InProgress)
                | (Self::Resolved, Self::Closed)
                | (Self::Resolved, Self::InProgress)
        )
    }

    /// Apply a status transition, enforcing the FSM. Returns the captured
    /// `from → to` edge for auditing, or an illegal-transition error.
    pub fn transition_to(self, to: Self) -> Result<Transition<Self>, KernelError> {
        if self.can_transition_to(to) {
            Ok(Transition { from: self, to })
        } else {
            Err(TransitionError { from: self, to }.into())
        }
    }

    /// Terminal states accept no further transitions.
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Closed)
    }
}

impl std::fmt::Display for TicketStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_db_str())
    }
}

/// Where the ticket entered the system.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TicketOrigin {
    /// Authenticated staff member; carries the requester's branch.
    Internal,
    /// Unauthenticated external customer; branch-less until triaged.
    Customer,
}

impl TicketOrigin {
    #[must_use]
    pub const fn as_db_str(self) -> &'static str {
        match self {
            Self::Internal => "INTERNAL",
            Self::Customer => "CUSTOMER",
        }
    }

    pub fn from_db_str(value: &str) -> Result<Self, KernelError> {
        match value {
            "INTERNAL" => Ok(Self::Internal),
            "CUSTOMER" => Ok(Self::Customer),
            other => Err(KernelError::validation(format!(
                "unknown support ticket origin {other:?}"
            ))),
        }
    }
}

/// Coarse classification used for routing and filtering.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TicketCategory {
    SystemBug,
    AccessRequest,
    Operational,
    EquipmentInquiry,
    Complaint,
    Other,
}

impl TicketCategory {
    #[must_use]
    pub const fn as_db_str(self) -> &'static str {
        match self {
            Self::SystemBug => "SYSTEM_BUG",
            Self::AccessRequest => "ACCESS_REQUEST",
            Self::Operational => "OPERATIONAL",
            Self::EquipmentInquiry => "EQUIPMENT_INQUIRY",
            Self::Complaint => "COMPLAINT",
            Self::Other => "OTHER",
        }
    }

    pub fn from_db_str(value: &str) -> Result<Self, KernelError> {
        match value {
            "SYSTEM_BUG" => Ok(Self::SystemBug),
            "ACCESS_REQUEST" => Ok(Self::AccessRequest),
            "OPERATIONAL" => Ok(Self::Operational),
            "EQUIPMENT_INQUIRY" => Ok(Self::EquipmentInquiry),
            "COMPLAINT" => Ok(Self::Complaint),
            "OTHER" => Ok(Self::Other),
            other => Err(KernelError::validation(format!(
                "unknown support ticket category {other:?}"
            ))),
        }
    }
}

/// Priority drives the SLA `due_at` derived on create.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TicketPriority {
    Low,
    Medium,
    High,
    Urgent,
}

impl TicketPriority {
    #[must_use]
    pub const fn as_db_str(self) -> &'static str {
        match self {
            Self::Low => "LOW",
            Self::Medium => "MEDIUM",
            Self::High => "HIGH",
            Self::Urgent => "URGENT",
        }
    }

    pub fn from_db_str(value: &str) -> Result<Self, KernelError> {
        match value {
            "LOW" => Ok(Self::Low),
            "MEDIUM" => Ok(Self::Medium),
            "HIGH" => Ok(Self::High),
            "URGENT" => Ok(Self::Urgent),
            other => Err(KernelError::validation(format!(
                "unknown support ticket priority {other:?}"
            ))),
        }
    }

    /// SLA response window for this priority. Configurable via [`SlaPolicy`];
    /// these are the default targets.
    #[must_use]
    pub const fn default_sla(self) -> Duration {
        match self {
            Self::Urgent => Duration::hours(4),
            Self::High => Duration::days(1),
            Self::Medium => Duration::days(3),
            Self::Low => Duration::days(7),
        }
    }
}

/// Maps a priority to its SLA window. Defaults match [`TicketPriority::default_sla`];
/// kept as a struct so deployment-specific targets can override the constants
/// without touching call sites.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlaPolicy {
    pub urgent: Duration,
    pub high: Duration,
    pub medium: Duration,
    pub low: Duration,
}

impl Default for SlaPolicy {
    fn default() -> Self {
        Self {
            urgent: TicketPriority::Urgent.default_sla(),
            high: TicketPriority::High.default_sla(),
            medium: TicketPriority::Medium.default_sla(),
            low: TicketPriority::Low.default_sla(),
        }
    }
}

impl SlaPolicy {
    #[must_use]
    pub const fn window_for(&self, priority: TicketPriority) -> Duration {
        match priority {
            TicketPriority::Urgent => self.urgent,
            TicketPriority::High => self.high,
            TicketPriority::Medium => self.medium,
            TicketPriority::Low => self.low,
        }
    }

    /// SLA `due_at` for a ticket created at `created_at` with `priority`.
    pub fn due_at(
        &self,
        priority: TicketPriority,
        created_at: Timestamp,
    ) -> Result<Timestamp, KernelError> {
        created_at
            .checked_add(self.window_for(priority))
            .ok_or_else(|| KernelError::validation("support SLA due_at overflows time"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    const ALL_STATUSES: [TicketStatus; 5] = [
        TicketStatus::Open,
        TicketStatus::InProgress,
        TicketStatus::OnHold,
        TicketStatus::Resolved,
        TicketStatus::Closed,
    ];

    #[test]
    fn valid_transitions_are_accepted() {
        let valid = [
            (TicketStatus::Open, TicketStatus::InProgress),
            (TicketStatus::InProgress, TicketStatus::OnHold),
            (TicketStatus::InProgress, TicketStatus::Resolved),
            (TicketStatus::OnHold, TicketStatus::InProgress),
            (TicketStatus::Resolved, TicketStatus::Closed),
            (TicketStatus::Resolved, TicketStatus::InProgress),
        ];
        for (from, to) in valid {
            let transition = from
                .transition_to(to)
                .unwrap_or_else(|_| panic!("{from} -> {to} must be valid"));
            assert_eq!(transition.from, from);
            assert_eq!(transition.to, to);
        }
    }

    #[test]
    fn invalid_transitions_are_rejected_for_full_matrix() {
        let valid = |from: TicketStatus, to: TicketStatus| {
            matches!(
                (from, to),
                (TicketStatus::Open, TicketStatus::InProgress)
                    | (TicketStatus::InProgress, TicketStatus::OnHold)
                    | (TicketStatus::InProgress, TicketStatus::Resolved)
                    | (TicketStatus::OnHold, TicketStatus::InProgress)
                    | (TicketStatus::Resolved, TicketStatus::Closed)
                    | (TicketStatus::Resolved, TicketStatus::InProgress)
            )
        };
        for from in ALL_STATUSES {
            for to in ALL_STATUSES {
                let allowed = from.can_transition_to(to);
                assert_eq!(
                    allowed,
                    valid(from, to),
                    "matrix mismatch for {from} -> {to}"
                );
                if !allowed {
                    assert!(
                        from.transition_to(to).is_err(),
                        "{from} -> {to} must be rejected"
                    );
                }
            }
        }
    }

    #[test]
    fn no_self_transition_is_allowed() {
        for status in ALL_STATUSES {
            assert!(
                status.transition_to(status).is_err(),
                "{status} -> {status} self-loop must be rejected"
            );
        }
    }

    #[test]
    fn closed_is_terminal() {
        assert!(TicketStatus::Closed.is_terminal());
        for to in ALL_STATUSES {
            assert!(TicketStatus::Closed.transition_to(to).is_err());
        }
    }

    #[test]
    fn resolved_can_reopen_to_in_progress() {
        let transition = TicketStatus::Resolved
            .transition_to(TicketStatus::InProgress)
            .unwrap();
        assert_eq!(transition.from, TicketStatus::Resolved);
        assert_eq!(transition.to, TicketStatus::InProgress);
    }

    #[test]
    fn sla_due_at_is_derived_from_priority() {
        let created = datetime!(2026-06-13 09:00 UTC);
        let policy = SlaPolicy::default();
        assert_eq!(
            policy.due_at(TicketPriority::Urgent, created).unwrap(),
            created + Duration::hours(4)
        );
        assert_eq!(
            policy.due_at(TicketPriority::High, created).unwrap(),
            created + Duration::days(1)
        );
        assert_eq!(
            policy.due_at(TicketPriority::Medium, created).unwrap(),
            created + Duration::days(3)
        );
        assert_eq!(
            policy.due_at(TicketPriority::Low, created).unwrap(),
            created + Duration::days(7)
        );
    }

    #[test]
    fn db_str_roundtrips_for_all_enums() {
        for status in ALL_STATUSES {
            assert_eq!(
                TicketStatus::from_db_str(status.as_db_str()).unwrap(),
                status
            );
        }
        for origin in [TicketOrigin::Internal, TicketOrigin::Customer] {
            assert_eq!(
                TicketOrigin::from_db_str(origin.as_db_str()).unwrap(),
                origin
            );
        }
        for category in [
            TicketCategory::SystemBug,
            TicketCategory::AccessRequest,
            TicketCategory::Operational,
            TicketCategory::EquipmentInquiry,
            TicketCategory::Complaint,
            TicketCategory::Other,
        ] {
            assert_eq!(
                TicketCategory::from_db_str(category.as_db_str()).unwrap(),
                category
            );
        }
        for priority in [
            TicketPriority::Low,
            TicketPriority::Medium,
            TicketPriority::High,
            TicketPriority::Urgent,
        ] {
            assert_eq!(
                TicketPriority::from_db_str(priority.as_db_str()).unwrap(),
                priority
            );
        }
    }
}
