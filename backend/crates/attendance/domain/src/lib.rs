//! Attendance value objects and invariants.  This crate is deliberately pure:
//! it knows neither HTTP, authentication, nor SQL.
#![cfg_attr(test, allow(clippy::unwrap_used))]

use serde::{Deserialize, Serialize};
use time::{Date, Duration, Month};
use uuid::Uuid;

pub const MAX_SUBSTITUTION_RANGE_DAYS: i64 = 38; // selected month plus D+7

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExceptionKind {
    Late,
    NoShow,
    UnapprovedOvertime,
    EarlyLeave,
}

impl ExceptionKind {
    pub fn parse(value: &str) -> Result<Self, AttendanceDomainError> {
        match value {
            "LATE" => Ok(Self::Late),
            "NO_SHOW" => Ok(Self::NoShow),
            "UNAPPROVED_OVERTIME" => Ok(Self::UnapprovedOvertime),
            "EARLY_LEAVE" => Ok(Self::EarlyLeave),
            _ => Err(AttendanceDomainError::InvalidExceptionKind),
        }
    }
    #[must_use]
    pub const fn as_db(self) -> &'static str {
        match self {
            Self::Late => "LATE",
            Self::NoShow => "NO_SHOW",
            Self::UnapprovedOvertime => "UNAPPROVED_OVERTIME",
            Self::EarlyLeave => "EARLY_LEAVE",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttendanceDateRange {
    pub from: Date,
    pub to_exclusive: Date,
}

impl AttendanceDateRange {
    pub fn new(from: Date, to_exclusive: Date) -> Result<Self, AttendanceDomainError> {
        if to_exclusive <= from || (to_exclusive - from).whole_days() > MAX_SUBSTITUTION_RANGE_DAYS
        {
            return Err(AttendanceDomainError::RangeOutOfBounds);
        }
        Ok(Self { from, to_exclusive })
    }
    pub fn selected_month_with_buffer(month: &str) -> Result<Self, AttendanceDomainError> {
        let (year, raw_month) = month
            .split_once('-')
            .ok_or(AttendanceDomainError::InvalidMonth)?;
        let year = year
            .parse::<i32>()
            .map_err(|_| AttendanceDomainError::InvalidMonth)?;
        let month = raw_month
            .parse::<u8>()
            .ok()
            .and_then(|m| Month::try_from(m).ok())
            .ok_or(AttendanceDomainError::InvalidMonth)?;
        let from = Date::from_calendar_date(year, month, 1)
            .map_err(|_| AttendanceDomainError::InvalidMonth)?;
        let next = if month == Month::December {
            Date::from_calendar_date(year + 1, Month::January, 1)
        } else {
            Date::from_calendar_date(year, month.next(), 1)
        }
        .map_err(|_| AttendanceDomainError::InvalidMonth)?;
        Self::new(from, next + Duration::days(7))
    }
    #[must_use]
    pub fn includes(&self, date: Date) -> bool {
        date >= self.from && date < self.to_exclusive
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubstitutionWindow {
    pub cover_date: Date,
    pub from_minutes: i32,
    pub to_minutes: i32,
}
impl SubstitutionWindow {
    pub fn new(
        cover_date: Date,
        from_minutes: i32,
        to_minutes: i32,
    ) -> Result<Self, AttendanceDomainError> {
        if !(0..=1440).contains(&from_minutes)
            || !(1..=1440).contains(&to_minutes)
            || to_minutes <= from_minutes
        {
            return Err(AttendanceDomainError::InvalidCoverageWindow);
        }
        Ok(Self {
            cover_date,
            from_minutes,
            to_minutes,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoricalAbsence {
    pub employee_id: Uuid,
    pub work_date: Date,
    pub from_minutes: i32,
    pub to_minutes: i32,
}
impl HistoricalAbsence {
    pub fn new(
        employee_id: Uuid,
        work_date: Date,
        from_minutes: i32,
        to_minutes: i32,
    ) -> Result<Self, AttendanceDomainError> {
        if !(0..=1440).contains(&from_minutes)
            || !(1..=1440).contains(&to_minutes)
            || to_minutes <= from_minutes
        {
            return Err(AttendanceDomainError::InvalidAbsenceInterval);
        }
        Ok(Self {
            employee_id,
            work_date,
            from_minutes,
            to_minutes,
        })
    }
    #[must_use]
    pub fn fully_covers(&self, employee_id: Uuid, window: &SubstitutionWindow) -> bool {
        self.employee_id == employee_id
            && self.work_date == window.cover_date
            && self.from_minutes <= window.from_minutes
            && self.to_minutes >= window.to_minutes
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ResolutionAction {
    Confirm,
    ApproveOvertime,
}
impl ResolutionAction {
    pub fn parse(value: &str) -> Result<Self, AttendanceDomainError> {
        match value {
            "CONFIRM" => Ok(Self::Confirm),
            "APPROVE_OVERTIME" => Ok(Self::ApproveOvertime),
            _ => Err(AttendanceDomainError::InvalidResolutionAction),
        }
    }
    #[must_use]
    pub const fn as_db(self) -> &'static str {
        match self {
            Self::Confirm => "CONFIRM",
            Self::ApproveOvertime => "APPROVE_OVERTIME",
        }
    }
    pub fn validate_for(
        self,
        kind: ExceptionKind,
        linked_work_ref: Option<&str>,
        overtime_minutes: Option<i32>,
    ) -> Result<(), AttendanceDomainError> {
        match (kind, self) {
            (ExceptionKind::UnapprovedOvertime, Self::ApproveOvertime)
                if linked_work_ref.is_some_and(|v| !v.trim().is_empty())
                    && overtime_minutes.is_some_and(|v| v > 0) =>
            {
                Ok(())
            }
            (ExceptionKind::UnapprovedOvertime, _) => {
                Err(AttendanceDomainError::InvalidResolutionTransition)
            }
            (_, Self::Confirm) if linked_work_ref.is_none() && overtime_minutes.is_none() => Ok(()),
            _ => Err(AttendanceDomainError::InvalidResolutionTransition),
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AttendanceDomainError {
    #[error("month must be YYYY-MM")]
    InvalidMonth,
    #[error("range must be positive and no longer than selected month plus D+7")]
    RangeOutOfBounds,
    #[error("coverage window must be within a day and non-empty")]
    InvalidCoverageWindow,
    #[error("exception kind is not supported")]
    InvalidExceptionKind,
    #[error("absence interval must be within a day and non-empty")]
    InvalidAbsenceInterval,
    #[error("resolution action is not supported")]
    InvalidResolutionAction,
    #[error("resolution action is invalid for this exception kind")]
    InvalidResolutionTransition,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selected_month_is_explicit_and_bounded() {
        let r = AttendanceDateRange::selected_month_with_buffer("2026-07").unwrap();
        assert_eq!(r.from.to_string(), "2026-07-01");
        assert_eq!(r.to_exclusive.to_string(), "2026-08-08");
        assert!(AttendanceDateRange::new(r.from, r.to_exclusive + Duration::days(1)).is_err());
    }
    #[test]
    fn historical_coverage_requires_full_same_day_interval() {
        let employee = Uuid::new_v4();
        let date = Date::from_calendar_date(2026, Month::July, 2).unwrap();
        let window = SubstitutionWindow::new(date, 540, 1020).unwrap();
        assert!(
            HistoricalAbsence::new(employee, date, 480, 1080)
                .unwrap()
                .fully_covers(employee, &window)
        );
        assert!(
            !HistoricalAbsence::new(employee, date, 541, 1020)
                .unwrap()
                .fully_covers(employee, &window)
        );
    }
    #[test]
    fn overtime_resolution_has_a_kind_action_matrix() {
        assert!(
            ResolutionAction::ApproveOvertime
                .validate_for(ExceptionKind::UnapprovedOvertime, Some("WO-1"), Some(60))
                .is_ok()
        );
        assert!(
            ResolutionAction::Confirm
                .validate_for(ExceptionKind::UnapprovedOvertime, None, None)
                .is_err()
        );
        assert!(
            ResolutionAction::ApproveOvertime
                .validate_for(ExceptionKind::Late, Some("WO-1"), Some(60))
                .is_err()
        );
    }
}
