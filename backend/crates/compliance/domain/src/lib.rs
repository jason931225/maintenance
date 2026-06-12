//! Compliance domain.
//!
//! Pure state machines and value objects only. Postgres partitioning,
//! transactions, and audit persistence live in outer crates.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_kernel_core::{
    BranchId, ConsentId, KernelError, LocationPingId, Timestamp, Transition, TransitionError,
    UserId,
};
use time::Duration;

/// Location-consent FSM states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LocationConsentState {
    /// No persisted consent record exists yet.
    NoRecord,
    /// Individual consent is active; on-duty pings may be collected.
    Granted,
    /// The non-refusable off switch is active; collection must stop.
    Suspended,
    /// Consent was withdrawn and destructible ping data must be destroyed.
    Withdrawn,
}

impl LocationConsentState {
    #[must_use]
    pub const fn as_db_str(self) -> &'static str {
        match self {
            Self::NoRecord => "NO_RECORD",
            Self::Granted => "GRANTED",
            Self::Suspended => "SUSPENDED",
            Self::Withdrawn => "WITHDRAWN",
        }
    }

    pub fn from_db_str(value: &str) -> Result<Self, KernelError> {
        match value {
            "NO_RECORD" => Ok(Self::NoRecord),
            "GRANTED" => Ok(Self::Granted),
            "SUSPENDED" => Ok(Self::Suspended),
            "WITHDRAWN" => Ok(Self::Withdrawn),
            other => Err(KernelError::validation(format!(
                "unknown location consent state {other:?}"
            ))),
        }
    }
}

/// Current consent ledger head for one user.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LocationConsent {
    id: ConsentId,
    user_id: UserId,
    branch_id: BranchId,
    state: LocationConsentState,
    granted_at: Option<Timestamp>,
    suspended_at: Option<Timestamp>,
    resumed_at: Option<Timestamp>,
    withdrawn_at: Option<Timestamp>,
    updated_at: Option<Timestamp>,
}

/// Database row shape used by outer adapters to rehydrate a consent ledger head.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistedLocationConsent {
    pub id: ConsentId,
    pub user_id: UserId,
    pub branch_id: BranchId,
    pub state: LocationConsentState,
    pub granted_at: Option<Timestamp>,
    pub suspended_at: Option<Timestamp>,
    pub resumed_at: Option<Timestamp>,
    pub withdrawn_at: Option<Timestamp>,
    pub updated_at: Timestamp,
}

impl LocationConsent {
    #[must_use]
    pub fn unrecorded(user_id: UserId, branch_id: BranchId) -> Self {
        Self {
            id: ConsentId::new(),
            user_id,
            branch_id,
            state: LocationConsentState::NoRecord,
            granted_at: None,
            suspended_at: None,
            resumed_at: None,
            withdrawn_at: None,
            updated_at: None,
        }
    }

    #[must_use]
    pub fn from_persisted(row: PersistedLocationConsent) -> Self {
        Self {
            id: row.id,
            user_id: row.user_id,
            branch_id: row.branch_id,
            state: row.state,
            granted_at: row.granted_at,
            suspended_at: row.suspended_at,
            resumed_at: row.resumed_at,
            withdrawn_at: row.withdrawn_at,
            updated_at: Some(row.updated_at),
        }
    }

    #[must_use]
    pub const fn id(&self) -> ConsentId {
        self.id
    }

    #[must_use]
    pub const fn user_id(&self) -> UserId {
        self.user_id
    }

    #[must_use]
    pub const fn branch_id(&self) -> BranchId {
        self.branch_id
    }

    #[must_use]
    pub const fn state(&self) -> LocationConsentState {
        self.state
    }

    #[must_use]
    pub const fn granted_at(&self) -> Option<Timestamp> {
        self.granted_at
    }

    #[must_use]
    pub const fn suspended_at(&self) -> Option<Timestamp> {
        self.suspended_at
    }

    #[must_use]
    pub const fn resumed_at(&self) -> Option<Timestamp> {
        self.resumed_at
    }

    #[must_use]
    pub const fn withdrawn_at(&self) -> Option<Timestamp> {
        self.withdrawn_at
    }

    #[must_use]
    pub const fn updated_at(&self) -> Option<Timestamp> {
        self.updated_at
    }

    pub fn grant(
        &mut self,
        at: Timestamp,
    ) -> Result<Transition<LocationConsentState>, KernelError> {
        match self.state {
            LocationConsentState::NoRecord | LocationConsentState::Withdrawn => {
                let transition = self.transition_to(LocationConsentState::Granted, at);
                self.granted_at = Some(at);
                self.suspended_at = None;
                self.resumed_at = None;
                self.withdrawn_at = None;
                Ok(transition)
            }
            from => Err(illegal(from, LocationConsentState::Granted)),
        }
    }

    pub fn suspend(
        &mut self,
        at: Timestamp,
    ) -> Result<Transition<LocationConsentState>, KernelError> {
        match self.state {
            LocationConsentState::Granted => {
                let transition = self.transition_to(LocationConsentState::Suspended, at);
                self.suspended_at = Some(at);
                Ok(transition)
            }
            from => Err(illegal(from, LocationConsentState::Suspended)),
        }
    }

    pub fn resume(
        &mut self,
        at: Timestamp,
    ) -> Result<Transition<LocationConsentState>, KernelError> {
        match self.state {
            LocationConsentState::Suspended => {
                let transition = self.transition_to(LocationConsentState::Granted, at);
                self.suspended_at = None;
                self.resumed_at = Some(at);
                Ok(transition)
            }
            from => Err(illegal(from, LocationConsentState::Granted)),
        }
    }

    pub fn withdraw(
        &mut self,
        at: Timestamp,
    ) -> Result<Transition<LocationConsentState>, KernelError> {
        match self.state {
            LocationConsentState::Granted | LocationConsentState::Suspended => {
                let transition = self.transition_to(LocationConsentState::Withdrawn, at);
                self.suspended_at = None;
                self.withdrawn_at = Some(at);
                Ok(transition)
            }
            from => Err(illegal(from, LocationConsentState::Withdrawn)),
        }
    }

    fn transition_to(
        &mut self,
        to: LocationConsentState,
        at: Timestamp,
    ) -> Transition<LocationConsentState> {
        let from = self.state;
        self.state = to;
        self.updated_at = Some(at);
        Transition { from, to }
    }
}

fn illegal(from: LocationConsentState, to: LocationConsentState) -> KernelError {
    TransitionError { from, to }.into()
}

/// A validated GPS coordinate pair.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Coordinates {
    latitude: f64,
    longitude: f64,
}

impl Coordinates {
    pub fn new(latitude: f64, longitude: f64) -> Result<Self, KernelError> {
        if !latitude.is_finite() || !(-90.0..=90.0).contains(&latitude) {
            return Err(KernelError::validation(format!(
                "latitude must be finite and within -90..=90, got {latitude}"
            )));
        }
        if !longitude.is_finite() || !(-180.0..=180.0).contains(&longitude) {
            return Err(KernelError::validation(format!(
                "longitude must be finite and within -180..=180, got {longitude}"
            )));
        }
        Ok(Self {
            latitude,
            longitude,
        })
    }

    #[must_use]
    pub const fn latitude(self) -> f64 {
        self.latitude
    }

    #[must_use]
    pub const fn longitude(self) -> f64 {
        self.longitude
    }
}

/// Destructible, non-audited location ping.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct LocationPing {
    id: LocationPingId,
    user_id: UserId,
    branch_id: BranchId,
    coordinates: Coordinates,
    accuracy_m: Option<f64>,
    recorded_at: Timestamp,
    on_duty: bool,
}

impl LocationPing {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: LocationPingId,
        user_id: UserId,
        branch_id: BranchId,
        latitude: f64,
        longitude: f64,
        accuracy_m: Option<f64>,
        recorded_at: Timestamp,
        on_duty: bool,
    ) -> Result<Self, KernelError> {
        if let Some(accuracy) = accuracy_m
            && (!accuracy.is_finite() || accuracy < 0.0)
        {
            return Err(KernelError::validation(format!(
                "accuracy_m must be finite and non-negative, got {accuracy}"
            )));
        }

        Ok(Self {
            id,
            user_id,
            branch_id,
            coordinates: Coordinates::new(latitude, longitude)?,
            accuracy_m,
            recorded_at,
            on_duty,
        })
    }

    #[must_use]
    pub const fn id(&self) -> LocationPingId {
        self.id
    }

    #[must_use]
    pub const fn user_id(&self) -> UserId {
        self.user_id
    }

    #[must_use]
    pub const fn branch_id(&self) -> BranchId {
        self.branch_id
    }

    #[must_use]
    pub const fn latitude(&self) -> f64 {
        self.coordinates.latitude()
    }

    #[must_use]
    pub const fn longitude(&self) -> f64 {
        self.coordinates.longitude()
    }

    #[must_use]
    pub const fn accuracy_m(&self) -> Option<f64> {
        self.accuracy_m
    }

    #[must_use]
    pub const fn recorded_at(&self) -> Timestamp {
        self.recorded_at
    }

    #[must_use]
    pub const fn on_duty(&self) -> bool {
        self.on_duty
    }
}

/// Upper bound for retained ping rows: users × on-duty window × ping rate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PingVolumeBound {
    user_count: u64,
    max_rows: u64,
}

impl PingVolumeBound {
    pub fn new(
        user_count: u64,
        on_duty_window: Duration,
        min_ping_interval: Duration,
    ) -> Result<Self, KernelError> {
        let window_seconds = positive_seconds(on_duty_window, "on_duty_window")?;
        let interval_seconds = positive_seconds(min_ping_interval, "min_ping_interval")?;
        let pings_per_user = window_seconds.div_ceil(interval_seconds);
        let max_rows = user_count
            .checked_mul(pings_per_user)
            .ok_or_else(|| KernelError::validation("ping volume bound overflows u64"))?;

        Ok(Self {
            user_count,
            max_rows,
        })
    }

    #[must_use]
    pub const fn user_count(self) -> u64 {
        self.user_count
    }

    #[must_use]
    pub const fn max_rows(self) -> u64 {
        self.max_rows
    }

    #[must_use]
    pub const fn allows(self, row_count: u64) -> bool {
        row_count <= self.max_rows
    }
}

fn positive_seconds(duration: Duration, field: &str) -> Result<u64, KernelError> {
    let seconds = duration.whole_seconds();
    if seconds <= 0 {
        return Err(KernelError::validation(format!(
            "{field} must be positive, got {seconds} seconds"
        )));
    }
    u64::try_from(seconds).map_err(|_| {
        KernelError::validation(format!(
            "{field} is too large to convert into an unsigned second count"
        ))
    })
}
