//! Leave-request domain — 연차 신청/결재 + 근로기준법 §61 statutory push.
//!
//! Pure value objects and validation only. Persistence, audit, org/branch
//! scoping, and REST live in outer layers. A [`LeaveRequest`] moves through a
//! four-state machine (`pending` → `approved`/`returned`/`rejected`); only a
//! `pending` request can be decided, and the decider is always separated from
//! the requester (SoD, mirroring the workflow-engine initiator guard #205).
//!
//! The statutory push ([`PromotionKind`]) is the employer's 연차 사용 촉진
//! (§61, two rounds) and, after the second round, the 노무수령거부 notice. Each
//! push is delivered as a receipt-gated document into the target's 개인 수신함.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_kernel_core::KernelError;
use serde::{Deserialize, Serialize};

const REASON_MAX: usize = 500;
const COMMENT_MAX: usize = 500;
/// Longest single leave span we accept (one fiscal year of working days). Wider
/// spans are almost always a client bug, not a real request.
const DAYS_MAX: f64 = 366.0;

/// 연차 (full annual-leave day) vs 반차 (half day).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LeaveType {
    /// 연차 — a full annual-leave day.
    Annual,
    /// 반차 — a half day.
    HalfDay,
}

impl LeaveType {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Annual => "annual",
            Self::HalfDay => "half_day",
        }
    }

    pub fn parse(value: &str) -> Result<Self, KernelError> {
        match value {
            "annual" => Ok(Self::Annual),
            "half_day" => Ok(Self::HalfDay),
            other => Err(KernelError::validation(format!(
                "unknown leave type: {other} (expected annual|half_day)"
            ))),
        }
    }
}

/// The lifecycle status of a leave request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LeaveStatus {
    Pending,
    Approved,
    Returned,
    Rejected,
}

impl LeaveStatus {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Returned => "returned",
            Self::Rejected => "rejected",
        }
    }

    pub fn parse(value: &str) -> Result<Self, KernelError> {
        match value {
            "pending" => Ok(Self::Pending),
            "approved" => Ok(Self::Approved),
            "returned" => Ok(Self::Returned),
            "rejected" => Ok(Self::Rejected),
            other => Err(KernelError::validation(format!(
                "unknown leave status: {other}"
            ))),
        }
    }
}

/// A decision on a pending leave request. `Approve` is the only action that
/// writes the leave ledger (used += days, remaining -= days); the other two are
/// terminal negative outcomes. `Return` and `Reject` require a comment (the
/// requester must be told why), mirroring the approval-inbox mandatory-comment
/// rule; `Approve`'s comment is optional.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LeaveDecision {
    Approve,
    Return,
    Reject,
}

impl LeaveDecision {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Approve => "approve",
            Self::Return => "return",
            Self::Reject => "reject",
        }
    }

    pub fn parse(value: &str) -> Result<Self, KernelError> {
        match value {
            "approve" => Ok(Self::Approve),
            "return" => Ok(Self::Return),
            "reject" => Ok(Self::Reject),
            other => Err(KernelError::validation(format!(
                "unknown leave decision: {other} (expected approve|return|reject)"
            ))),
        }
    }

    /// The terminal status this decision drives the request into.
    #[must_use]
    pub fn resulting_status(self) -> LeaveStatus {
        match self {
            Self::Approve => LeaveStatus::Approved,
            Self::Return => LeaveStatus::Returned,
            Self::Reject => LeaveStatus::Rejected,
        }
    }

    /// Whether this decision requires a mandatory comment.
    #[must_use]
    pub fn requires_comment(self) -> bool {
        matches!(self, Self::Return | Self::Reject)
    }

    /// Whether applying this decision writes the leave ledger effect.
    #[must_use]
    pub fn writes_ledger(self) -> bool {
        matches!(self, Self::Approve)
    }
}

/// The two statutory-push kinds. 연차 사용 촉진 has two rounds under §61
/// (round 1 = 사용 촉구, round 2 = 시기 지정); after round 2 the employer may
/// serve a 노무수령거부 notice to decline the labor and extinguish the leave-pay
/// liability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromotionKind {
    /// 연차 사용 촉진 (§61), round 1 or 2.
    Promotion,
    /// 노무수령거부 — served only after a round-2 promotion.
    Refusal,
}

impl PromotionKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Promotion => "promotion",
            Self::Refusal => "refusal",
        }
    }

    pub fn parse(value: &str) -> Result<Self, KernelError> {
        match value {
            "promotion" => Ok(Self::Promotion),
            "refusal" => Ok(Self::Refusal),
            other => Err(KernelError::validation(format!(
                "unknown promotion kind: {other} (expected promotion|refusal)"
            ))),
        }
    }

    /// The statutory notice subtype delivered into the 개인 수신함 and the legal
    /// basis surfaced in the passkey receipt gate.
    #[must_use]
    pub fn notice_type(self) -> &'static str {
        match self {
            Self::Promotion => "연차촉진",
            Self::Refusal => "노무수령거부",
        }
    }

    /// The statutory citation, in the formal article form used on legal
    /// notices (not the `§61` shorthand used in code comments/docs). The sole
    /// source of this string — `notice_body` renders it into the notice body
    /// too, rather than hardcoding its own copy.
    #[must_use]
    pub fn legal_basis(self) -> &'static str {
        "근로기준법 제61조"
    }
}

/// Validate the promotion round. Only round 1 or 2 exist for a promotion; a
/// refusal carries no round (it follows round 2). Returns the canonical round
/// (`1`/`2` for a promotion, `2` for a refusal — the round it follows).
pub fn validate_round(kind: PromotionKind, round: i16) -> Result<i16, KernelError> {
    match kind {
        PromotionKind::Promotion => {
            if round == 1 || round == 2 {
                Ok(round)
            } else {
                Err(KernelError::validation(
                    "연차 촉진 round must be 1 or 2 (§61)",
                ))
            }
        }
        // A refusal always follows a completed round-2 promotion.
        PromotionKind::Refusal => Ok(2),
    }
}

/// A validated new leave request, ready for the write port. `days` is positive
/// and bounded; a half-day is `0.5`. `reason` is required and bounded.
#[derive(Debug, Clone, PartialEq)]
pub struct NewLeaveRequest {
    pub leave_type: LeaveType,
    pub days: f64,
    pub start_date: mnt_kernel_core::Date,
    pub end_date: mnt_kernel_core::Date,
    pub reason: String,
}

impl NewLeaveRequest {
    pub fn new(
        leave_type: LeaveType,
        days: f64,
        start_date: mnt_kernel_core::Date,
        end_date: mnt_kernel_core::Date,
        reason: &str,
    ) -> Result<Self, KernelError> {
        if !days.is_finite() || days <= 0.0 {
            return Err(KernelError::validation("leave days must be positive"));
        }
        if days > DAYS_MAX {
            return Err(KernelError::validation(format!(
                "leave days must be at most {DAYS_MAX}"
            )));
        }
        if end_date < start_date {
            return Err(KernelError::validation(
                "leave end date must not precede the start date",
            ));
        }
        // A 반차 is a single half day; a 연차 span is at least a full day.
        if leave_type == LeaveType::HalfDay && (days - 0.5).abs() > f64::EPSILON {
            return Err(KernelError::validation(
                "a 반차 (half day) must be 0.5 days",
            ));
        }
        let reason = bounded(reason, "leave reason", REASON_MAX)?;
        Ok(Self {
            leave_type,
            days,
            start_date,
            end_date,
            reason,
        })
    }
}

/// Validate a decision comment against the mandatory-comment rule.
pub fn validate_decision_comment(
    decision: LeaveDecision,
    comment: Option<&str>,
) -> Result<Option<String>, KernelError> {
    let comment = match comment.map(str::trim).filter(|c| !c.is_empty()) {
        Some(c) => Some(bounded(c, "decision comment", COMMENT_MAX)?),
        None => None,
    };
    if decision.requires_comment() && comment.is_none() {
        return Err(KernelError::validation(format!(
            "a {} decision requires a comment",
            decision.as_str()
        )));
    }
    Ok(comment)
}

fn bounded(value: &str, field: &str, max: usize) -> Result<String, KernelError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(KernelError::validation(format!("{field} is required")));
    }
    if trimmed.chars().count() > max {
        return Err(KernelError::validation(format!(
            "{field} must be at most {max} characters"
        )));
    }
    Ok(trimmed.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mnt_kernel_core::Date;
    use time::Month;

    fn d(y: i32, m: u8, day: u8) -> Date {
        Date::from_calendar_date(y, Month::try_from(m).unwrap(), day).unwrap()
    }

    #[test]
    fn leave_type_and_status_roundtrip() {
        assert_eq!(LeaveType::parse("annual").unwrap(), LeaveType::Annual);
        assert_eq!(LeaveType::parse("half_day").unwrap(), LeaveType::HalfDay);
        assert!(LeaveType::parse("quarter").is_err());
        assert_eq!(LeaveStatus::parse("pending").unwrap(), LeaveStatus::Pending);
        assert!(LeaveStatus::parse("bogus").is_err());
    }

    #[test]
    fn decision_semantics() {
        assert!(LeaveDecision::Approve.writes_ledger());
        assert!(!LeaveDecision::Return.writes_ledger());
        assert!(LeaveDecision::Reject.requires_comment());
        assert!(!LeaveDecision::Approve.requires_comment());
        assert_eq!(
            LeaveDecision::Approve.resulting_status(),
            LeaveStatus::Approved
        );
        assert_eq!(
            LeaveDecision::Return.resulting_status(),
            LeaveStatus::Returned
        );
    }

    #[test]
    fn return_and_reject_need_a_comment() {
        assert!(validate_decision_comment(LeaveDecision::Reject, None).is_err());
        assert!(validate_decision_comment(LeaveDecision::Return, Some("   ")).is_err());
        assert!(validate_decision_comment(LeaveDecision::Reject, Some("사유 미비")).is_ok());
        // Approve may omit a comment.
        assert!(validate_decision_comment(LeaveDecision::Approve, None).is_ok());
    }

    #[test]
    fn new_request_validation() {
        assert!(
            NewLeaveRequest::new(LeaveType::Annual, 0.0, d(2026, 7, 6), d(2026, 7, 6), "휴가")
                .is_err()
        );
        assert!(
            NewLeaveRequest::new(
                LeaveType::Annual,
                -1.0,
                d(2026, 7, 6),
                d(2026, 7, 6),
                "휴가"
            )
            .is_err()
        );
        assert!(
            NewLeaveRequest::new(
                LeaveType::HalfDay,
                1.0,
                d(2026, 7, 6),
                d(2026, 7, 6),
                "반차"
            )
            .is_err(),
            "half day must be 0.5"
        );
        assert!(
            NewLeaveRequest::new(LeaveType::Annual, 1.0, d(2026, 7, 7), d(2026, 7, 6), "휴가")
                .is_err()
        );
        assert!(
            NewLeaveRequest::new(LeaveType::Annual, 1.0, d(2026, 7, 6), d(2026, 7, 6), "  ")
                .is_err()
        );
        assert!(
            NewLeaveRequest::new(
                LeaveType::HalfDay,
                0.5,
                d(2026, 7, 6),
                d(2026, 7, 6),
                "반차"
            )
            .is_ok()
        );
        assert!(
            NewLeaveRequest::new(
                LeaveType::Annual,
                3.0,
                d(2026, 7, 6),
                d(2026, 7, 8),
                "여름 휴가"
            )
            .is_ok()
        );
    }

    #[test]
    fn round_validation() {
        assert_eq!(validate_round(PromotionKind::Promotion, 1).unwrap(), 1);
        assert_eq!(validate_round(PromotionKind::Promotion, 2).unwrap(), 2);
        assert!(validate_round(PromotionKind::Promotion, 3).is_err());
        assert!(validate_round(PromotionKind::Promotion, 0).is_err());
        // A refusal normalizes to the round it follows.
        assert_eq!(validate_round(PromotionKind::Refusal, 0).unwrap(), 2);
    }
}
