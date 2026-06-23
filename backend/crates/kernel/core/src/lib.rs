//! Shared kernel for the 정비/렌탈 FSM backend.
//!
//! Layering contract: everything depends inward on this crate; this crate
//! depends on nothing in the workspace. Pure data and logic only — no async
//! runtime, no sqlx, no axum (enforced by the CI layer-boundary gate, T0.2).
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

pub mod audit;
pub mod branch;
pub mod clock;
pub mod error;
pub mod ids;
pub mod redact;
pub mod trace;
pub mod transition;
pub mod validation;

pub use audit::{AuditAction, AuditEvent};
pub use branch::BranchScope;
pub use clock::{Clock, FixedClock, SystemClock};
pub use error::{ErrorKind, KernelError};
pub use ids::*;
pub use redact::RedactedPhone;
pub use trace::TraceContext;
pub use transition::{Transition, TransitionError};
pub use validation::{
    ADDRESS_MAX_CHARS, CITY_MAX_CHARS, CONTACT_EMAIL_MAX_CHARS, CONTACT_NAME_MAX_CHARS,
    CONTACT_PHONE_MAX_CHARS, CUSTOMER_SITE_NAME_MAX_CHARS, DEFAULT_GEOFENCE_RADIUS_M,
    POSTAL_CODE_MAX_CHARS, PROVINCE_MAX_CHARS, haversine_meters, haversine_meters_f64,
    validate_bounded_text, validate_coordinate_pair, validate_latitude, validate_longitude,
};

/// Canonical timestamp type for the whole system (UTC, RFC 3339 on the wire).
pub type Timestamp = time::OffsetDateTime;
