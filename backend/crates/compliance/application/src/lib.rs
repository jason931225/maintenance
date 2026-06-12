//! Compliance application layer.
//!
//! Use-case commands and ports live here; concrete storage remains in adapter
//! crates.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_compliance_domain::{LocationConsent, LocationConsentState};
use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, KernelError, Timestamp, TraceContext, Transition, UserId,
};
use serde::{Deserialize, Serialize};

/// Consent transition requested by an outer adapter/use case.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsentTransitionKind {
    Grant,
    Suspend,
    Resume,
    Withdraw,
}

impl ConsentTransitionKind {
    #[must_use]
    pub const fn audit_action(self) -> &'static str {
        match self {
            Self::Grant => "consent.grant",
            Self::Suspend => "consent.suspend",
            Self::Resume => "consent.resume",
            Self::Withdraw => "consent.withdraw",
        }
    }

    pub fn apply(
        self,
        consent: &mut LocationConsent,
        occurred_at: Timestamp,
    ) -> Result<Transition<LocationConsentState>, KernelError> {
        match self {
            Self::Grant => consent.grant(occurred_at),
            Self::Suspend => consent.suspend(occurred_at),
            Self::Resume => consent.resume(occurred_at),
            Self::Withdraw => consent.withdraw(occurred_at),
        }
    }
}

/// Command data required to mutate the LocationConsent ledger.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsentTransitionCommand {
    pub kind: ConsentTransitionKind,
    pub actor: Option<UserId>,
    pub user_id: UserId,
    pub branch_id: BranchId,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

pub fn consent_audit_event(
    command: &ConsentTransitionCommand,
    before: &LocationConsent,
    after: &LocationConsent,
) -> Result<AuditEvent, KernelError> {
    let action = AuditAction::new(command.kind.audit_action())?;
    let before_json = serde_json::to_value(before).map_err(|err| {
        KernelError::internal(format!(
            "failed to serialize consent before snapshot: {err}"
        ))
    })?;
    let after_json = serde_json::to_value(after).map_err(|err| {
        KernelError::internal(format!("failed to serialize consent after snapshot: {err}"))
    })?;

    Ok(AuditEvent::new(
        command.actor,
        action,
        "location_consent",
        after.id().to_string(),
        command.trace.clone(),
        command.occurred_at,
    )
    .with_branch(command.branch_id)
    .with_snapshots(Some(before_json), Some(after_json)))
}

/// Filters for reading the audited consent lifecycle ledger.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocationConsentLedgerQuery {
    pub user_id: Option<UserId>,
    pub branch_id: Option<BranchId>,
    pub limit: i64,
    pub offset: i64,
}

/// One audited consent lifecycle transition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocationConsentLedgerEntry {
    pub id: String,
    pub consent_id: String,
    pub user_id: UserId,
    pub branch_id: BranchId,
    pub actor: Option<UserId>,
    pub action: String,
    pub from_status: LocationConsentState,
    pub to_status: LocationConsentState,
    pub occurred_at: Timestamp,
    pub created_at: Timestamp,
}

/// Paged consent lifecycle ledger.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocationConsentLedgerPage {
    pub items: Vec<LocationConsentLedgerEntry>,
    pub limit: i64,
    pub offset: i64,
    pub total: i64,
}
