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
const LEAVE_UNITS_PER_DAY: i64 = 1_000_000;
const LEAVE_UNITS_STORAGE_MAX: i64 = 9_999_999_999_999_999;

/// 연차 (full annual-leave day) vs 반차 (half day).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LeaveType {
    /// 연차 — a full annual-leave day.
    Annual,
    /// 반차 — a half day.
    HalfDay,
}

/// Which scheduled portion of a date a half-day request targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PartialDayPeriod {
    Am,
    Pm,
}

impl PartialDayPeriod {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Am => "am",
            Self::Pm => "pm",
        }
    }

    pub fn parse(value: &str) -> Result<Self, KernelError> {
        match value {
            "am" => Ok(Self::Am),
            "pm" => Ok(Self::Pm),
            other => Err(KernelError::validation(format!(
                "unknown partial-day period: {other} (expected am|pm)"
            ))),
        }
    }
}

/// Exact leave quantity in millionths of a day. Floating-point arithmetic is
/// deliberately excluded from all authoritative ledger and charge paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct LeaveUnits(i64);

impl LeaveUnits {
    pub const ZERO: Self = Self(0);
    pub const ONE_DAY: Self = Self(LEAVE_UNITS_PER_DAY);

    pub fn from_micros(micros: i64) -> Result<Self, KernelError> {
        if !(0..=LEAVE_UNITS_STORAGE_MAX).contains(&micros) {
            return Err(KernelError::validation(
                "leave units exceed the exact storage range",
            ));
        }
        Ok(Self(micros))
    }

    #[must_use]
    pub const fn micros(self) -> i64 {
        self.0
    }

    #[must_use]
    pub fn canonical_decimal(self) -> String {
        let whole = self.0 / LEAVE_UNITS_PER_DAY;
        let fractional = self.0 % LEAVE_UNITS_PER_DAY;
        format!("{whole}.{fractional:06}")
    }

    pub fn parse_decimal(value: &str) -> Result<Self, KernelError> {
        let value = value.trim();
        let (whole, fractional) = value.split_once('.').unwrap_or((value, ""));
        if whole.is_empty()
            || !whole.bytes().all(|byte| byte.is_ascii_digit())
            || !fractional.bytes().all(|byte| byte.is_ascii_digit())
            || fractional.len() > 6
        {
            return Err(KernelError::validation(
                "leave units must be a non-negative decimal with at most six fractional digits",
            ));
        }
        let whole: i64 = whole
            .parse()
            .map_err(|_| KernelError::validation("leave-unit whole days are out of range"))?;
        let fractional: i64 = if fractional.is_empty() {
            0
        } else {
            format!("{fractional:0<6}")
                .parse()
                .map_err(|_| KernelError::validation("leave-unit fraction is out of range"))?
        };
        let micros = whole
            .checked_mul(LEAVE_UNITS_PER_DAY)
            .and_then(|value| value.checked_add(fractional))
            .ok_or_else(|| KernelError::validation("leave units are out of range"))?;
        Self::from_micros(micros)
    }

    pub fn checked_add(self, other: Self) -> Result<Self, KernelError> {
        let micros = self
            .0
            .checked_add(other.0)
            .ok_or_else(|| KernelError::validation("leave-unit total overflow"))?;
        Self::from_micros(micros)
    }

    /// Compatibility-only presentation helper. Never use this value for
    /// persistence, comparison, or ledger arithmetic.
    #[deprecated(note = "use exact micros or a fixed-scale decimal string")]
    #[must_use]
    pub fn as_days_f64(self) -> f64 {
        self.0 as f64 / LEAVE_UNITS_PER_DAY as f64
    }
}

impl Serialize for LeaveUnits {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.canonical_decimal())
    }
}

impl<'de> Deserialize<'de> for LeaveUnits {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::parse_decimal(&value).map_err(serde::de::Error::custom)
    }
}

/// Exact signed leave-ledger amount in millionths of a day. Historical imports
/// may legitimately contain negative balances, unlike request charges.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct LeaveBalanceAmount(i64);

impl LeaveBalanceAmount {
    pub fn parse_decimal(value: &str) -> Result<Self, KernelError> {
        let value = value.trim();
        let (negative, magnitude) = match value.strip_prefix('-') {
            Some(magnitude) => (true, magnitude),
            None => (false, value),
        };
        let magnitude = LeaveUnits::parse_decimal(magnitude)?;
        let micros = if negative {
            magnitude
                .micros()
                .checked_neg()
                .ok_or_else(|| KernelError::validation("leave balance is out of range"))?
        } else {
            magnitude.micros()
        };
        Self::from_micros(micros)
    }

    pub fn from_micros(micros: i64) -> Result<Self, KernelError> {
        if !(-LEAVE_UNITS_STORAGE_MAX..=LEAVE_UNITS_STORAGE_MAX).contains(&micros) {
            return Err(KernelError::validation(
                "leave balance exceeds the exact storage range",
            ));
        }
        Ok(Self(micros))
    }

    #[must_use]
    pub const fn micros(self) -> i64 {
        self.0
    }

    #[must_use]
    pub fn canonical_decimal(self) -> String {
        let sign = if self.0 < 0 { "-" } else { "" };
        let magnitude = self.0.unsigned_abs();
        format!(
            "{sign}{}.{:06}",
            magnitude / 1_000_000,
            magnitude % 1_000_000
        )
    }
}

impl Serialize for LeaveBalanceAmount {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.canonical_decimal())
    }
}

impl<'de> Deserialize<'de> for LeaveBalanceAmount {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::parse_decimal(&value).map_err(serde::de::Error::custom)
    }
}

/// Why an authoritative charge could not be resolved automatically.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LeaveChargeReviewReason {
    MissingCalendar,
    AmbiguousCalendar,
    CalendarSourceUnavailable,
    MissingPolicy,
    AmbiguousPolicy,
    PolicySourceUnavailable,
}

impl LeaveChargeReviewReason {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MissingCalendar => "missing_calendar",
            Self::AmbiguousCalendar => "ambiguous_calendar",
            Self::CalendarSourceUnavailable => "calendar_source_unavailable",
            Self::MissingPolicy => "missing_policy",
            Self::AmbiguousPolicy => "ambiguous_policy",
            Self::PolicySourceUnavailable => "policy_source_unavailable",
        }
    }

    pub fn parse(value: &str) -> Result<Self, KernelError> {
        match value {
            "missing_calendar" => Ok(Self::MissingCalendar),
            "ambiguous_calendar" => Ok(Self::AmbiguousCalendar),
            "calendar_source_unavailable" => Ok(Self::CalendarSourceUnavailable),
            "missing_policy" => Ok(Self::MissingPolicy),
            "ambiguous_policy" => Ok(Self::AmbiguousPolicy),
            "policy_source_unavailable" => Ok(Self::PolicySourceUnavailable),
            other => Err(KernelError::validation(format!(
                "unknown leave charge review reason: {other}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LeaveChargeState {
    ReviewRequired,
    Resolved,
    NotRequired,
    LegacyUnverified,
}

impl LeaveChargeState {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReviewRequired => "review_required",
            Self::Resolved => "resolved",
            Self::NotRequired => "not_required",
            Self::LegacyUnverified => "legacy_unverified",
        }
    }

    pub fn parse(value: &str) -> Result<Self, KernelError> {
        match value {
            "review_required" => Ok(Self::ReviewRequired),
            "resolved" => Ok(Self::Resolved),
            "not_required" => Ok(Self::NotRequired),
            "legacy_unverified" => Ok(Self::LegacyUnverified),
            other => Err(KernelError::validation(format!(
                "unknown leave charge state: {other}"
            ))),
        }
    }
}

/// A date's authoritative work obligation as supplied by a calendar adapter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkObligation {
    Scheduled { minutes: u32 },
    NotScheduled { basis: NonWorkBasis },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NonWorkBasis {
    RestDay,
    PublicHoliday,
    SubstituteHoliday,
    ContractualDayOff,
    Other,
}

/// Immutable, per-date evidence used to derive an exact charge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaveDateCharge {
    pub date: mnt_kernel_core::Date,
    pub obligation: WorkObligation,
    pub units: LeaveUnits,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceRevisionRef {
    kind: String,
    reference: String,
    revision: String,
}

impl SourceRevisionRef {
    pub fn new(kind: &str, reference: &str, revision: &str) -> Result<Self, KernelError> {
        Ok(Self {
            kind: bounded(kind, "source kind", 64)?,
            reference: bounded(reference, "source reference", 256)?,
            revision: bounded(revision, "source revision", 128)?,
        })
    }

    #[must_use]
    pub fn kind(&self) -> &str {
        &self.kind
    }

    #[must_use]
    pub fn reference(&self) -> &str {
        &self.reference
    }

    #[must_use]
    pub fn revision(&self) -> &str {
        &self.revision
    }
}

/// Evidence returned by a calendar/policy adapter before it is recorded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaveChargeEvidence {
    pub home_branch_id: uuid::Uuid,
    pub calendar_revision_ref: SourceRevisionRef,
    pub policy_revision_ref: SourceRevisionRef,
    pub supporting_source_refs: Vec<SourceRevisionRef>,
    pub date_charges: Vec<LeaveDateCharge>,
}

/// Immutable, canonical snapshot persisted with a server-computed digest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordedLeaveChargeSnapshot {
    pub home_branch_id: uuid::Uuid,
    pub leave_type: LeaveType,
    pub partial_day_period: Option<PartialDayPeriod>,
    pub calendar_revision_ref: SourceRevisionRef,
    pub policy_revision_ref: SourceRevisionRef,
    pub supporting_source_refs: Vec<SourceRevisionRef>,
    pub date_charges: Vec<LeaveDateCharge>,
    pub total_units: LeaveUnits,
    pub server_digest: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LeaveChargeResolutionOrigin {
    Automated,
    Manual,
}

impl LeaveChargeResolutionOrigin {
    pub fn parse(value: &str) -> Result<Self, KernelError> {
        match value {
            "automated" => Ok(Self::Automated),
            "manual" => Ok(Self::Manual),
            other => Err(KernelError::validation(format!(
                "unknown leave charge resolution origin: {other}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum LeaveChargeAssessment {
    ReviewRequired {
        reasons: Vec<LeaveChargeReviewReason>,
    },
    Resolved {
        evidence: LeaveChargeEvidence,
    },
}

impl LeaveChargeAssessment {
    pub fn review_required(reasons: Vec<LeaveChargeReviewReason>) -> Result<Self, KernelError> {
        if reasons.is_empty() {
            return Err(KernelError::validation(
                "review-required charge must include at least one reason",
            ));
        }
        Ok(Self::ReviewRequired { reasons })
    }
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

/// A validated leave intent. Quantity is deliberately absent: it is resolved
/// from authoritative work-calendar and policy evidence after filing.
#[derive(Debug, Clone, PartialEq)]
pub struct NewLeaveRequest {
    pub leave_type: LeaveType,
    pub start_date: mnt_kernel_core::Date,
    pub end_date: mnt_kernel_core::Date,
    pub reason: String,
    pub partial_day_period: Option<PartialDayPeriod>,
}

impl NewLeaveRequest {
    pub fn new(
        leave_type: LeaveType,
        start_date: mnt_kernel_core::Date,
        end_date: mnt_kernel_core::Date,
        reason: &str,
        partial_day_period: Option<PartialDayPeriod>,
    ) -> Result<Self, KernelError> {
        if end_date < start_date {
            return Err(KernelError::validation(
                "leave end date must not precede the start date",
            ));
        }
        if (end_date - start_date).whole_days() >= 366 {
            return Err(KernelError::validation(
                "a leave request may span at most 366 calendar dates",
            ));
        }
        match leave_type {
            LeaveType::Annual if partial_day_period.is_some() => {
                return Err(KernelError::validation(
                    "partial-day period is only valid for half-day leave",
                ));
            }
            LeaveType::Annual => {}
            LeaveType::HalfDay => {
                if start_date != end_date {
                    return Err(KernelError::validation(
                        "a 반차 (half day) must start and end on the same date",
                    ));
                }
                if partial_day_period.is_none() {
                    return Err(KernelError::validation(
                        "a half-day request requires an am or pm period",
                    ));
                }
            }
        }
        let reason = bounded(reason, "leave reason", REASON_MAX)?;
        Ok(Self {
            leave_type,
            start_date,
            end_date,
            reason,
            partial_day_period,
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
            NewLeaveRequest::new(
                LeaveType::Annual,
                d(2026, 7, 7),
                d(2026, 7, 6),
                "휴가",
                None
            )
            .is_err()
        );
        assert!(
            NewLeaveRequest::new(
                LeaveType::HalfDay,
                d(2026, 7, 6),
                d(2026, 7, 7),
                "반차",
                Some(PartialDayPeriod::Am)
            )
            .is_err(),
            "half day must not span multiple dates"
        );
        assert!(
            NewLeaveRequest::new(LeaveType::Annual, d(2026, 7, 6), d(2026, 7, 6), "  ", None)
                .is_err()
        );
        assert!(
            NewLeaveRequest::new(
                LeaveType::HalfDay,
                d(2026, 7, 6),
                d(2026, 7, 6),
                "반차",
                None
            )
            .is_err()
        );
        assert!(
            NewLeaveRequest::new(
                LeaveType::Annual,
                d(2026, 7, 6),
                d(2026, 7, 8),
                "여름 휴가",
                None
            )
            .is_ok()
        );
        assert!(
            NewLeaveRequest::new(
                LeaveType::HalfDay,
                d(2026, 7, 6),
                d(2026, 7, 6),
                "오전 반차",
                Some(PartialDayPeriod::Am)
            )
            .is_ok()
        );
    }

    #[test]
    fn leave_units_are_exact_to_one_millionth() {
        for micros in [125_000, 400_000, 500_000] {
            let units = LeaveUnits::from_micros(micros).unwrap();
            assert_eq!(units.micros(), micros);
        }
        assert_eq!(
            LeaveUnits::from_micros(400_000)
                .unwrap()
                .checked_add(LeaveUnits::from_micros(125_000).unwrap())
                .unwrap()
                .micros(),
            525_000
        );
        let units = LeaveUnits::parse_decimal("0.125").unwrap();
        assert_eq!(units.micros(), 125_000);
        assert_eq!(units.canonical_decimal(), "0.125000");
        assert_eq!(
            serde_json::to_string(&LeaveUnits::from_micros(400_000).unwrap()).unwrap(),
            "\"0.400000\""
        );
        assert!(serde_json::from_str::<LeaveUnits>("400000").is_err());
    }

    #[test]
    fn historical_balance_amounts_preserve_signed_exact_values() {
        let amount = LeaveBalanceAmount::from_micros(-1_025_000).unwrap();
        assert_eq!(amount.canonical_decimal(), "-1.025000");
        assert_eq!(
            LeaveBalanceAmount::parse_decimal("1234.000001")
                .unwrap()
                .micros(),
            1_234_000_001
        );
        assert!(LeaveBalanceAmount::parse_decimal("0.0000001").is_err());
        assert!(LeaveBalanceAmount::parse_decimal("NaN").is_err());
        assert_eq!(
            serde_json::from_str::<LeaveBalanceAmount>("\"-0.125000\"")
                .unwrap()
                .micros(),
            -125_000
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
