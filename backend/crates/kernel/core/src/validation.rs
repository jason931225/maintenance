//! Shared, pure input validation for primitive value bounds.
//!
//! Domain crates own their rich newtypes (EquipmentNo, Ton, …); this module
//! holds only the small, cross-cutting numeric/text bounds that several layers
//! need to agree on. Keeping them here (kernel, no async / no sqlx) lets the
//! REST handler, the application command, and the DB CHECK constraints all
//! reference one source of truth for the same limit.
//!
//! Geographic coordinates are the first such bound: migration 0039 adds
//! latitude/longitude CHECKs to `registry_sites`, and the PATCH /sites handler
//! validates the same WGS84 ranges in the domain so a bad value is rejected with
//! a 422 before a transaction ever opens, rather than surfacing as a DB error.

use crate::error::KernelError;

/// WGS84 latitude bounds (degrees). Matches the
/// `registry_sites_latitude_range` CHECK in migration 0039.
pub const LATITUDE_MIN: f64 = -90.0;
pub const LATITUDE_MAX: f64 = 90.0;

/// WGS84 longitude bounds (degrees). Matches the
/// `registry_sites_longitude_range` CHECK in migration 0039.
pub const LONGITUDE_MIN: f64 = -180.0;
pub const LONGITUDE_MAX: f64 = 180.0;

/// Reject a latitude outside the WGS84 range, or a non-finite value (NaN/∞,
/// which no CHECK can store meaningfully). Returns the value unchanged on
/// success so callers can use it inline.
///
/// # Errors
/// Returns `KernelError::validation` when `value` is not finite or falls outside
/// `[-90, 90]`.
pub fn validate_latitude(value: f64) -> Result<f64, KernelError> {
    if !value.is_finite() {
        return Err(KernelError::validation("latitude must be a finite number"));
    }
    if !(LATITUDE_MIN..=LATITUDE_MAX).contains(&value) {
        return Err(KernelError::validation(format!(
            "latitude must be between {LATITUDE_MIN} and {LATITUDE_MAX}"
        )));
    }
    Ok(value)
}

/// Reject a longitude outside the WGS84 range, or a non-finite value.
///
/// # Errors
/// Returns `KernelError::validation` when `value` is not finite or falls outside
/// `[-180, 180]`.
pub fn validate_longitude(value: f64) -> Result<f64, KernelError> {
    if !value.is_finite() {
        return Err(KernelError::validation("longitude must be a finite number"));
    }
    if !(LONGITUDE_MIN..=LONGITUDE_MAX).contains(&value) {
        return Err(KernelError::validation(format!(
            "longitude must be between {LONGITUDE_MIN} and {LONGITUDE_MAX}"
        )));
    }
    Ok(value)
}

/// Validate an optional latitude/longitude pair for a site coordinate write.
///
/// A pin needs BOTH coordinates or NEITHER (mirrors the
/// `registry_sites_lat_lon_paired` CHECK): supplying exactly one is a
/// validation error, since a half-located site can neither be pinned nor cleanly
/// listed as ungeocoded. When both are present, each is range-checked.
///
/// # Errors
/// Returns `KernelError::validation` when exactly one of `latitude`/`longitude`
/// is `Some`, or when either value is out of range / non-finite.
pub fn validate_coordinate_pair(
    latitude: Option<f64>,
    longitude: Option<f64>,
) -> Result<(), KernelError> {
    match (latitude, longitude) {
        (Some(lat), Some(lon)) => {
            validate_latitude(lat)?;
            validate_longitude(lon)?;
            Ok(())
        }
        (None, None) => Ok(()),
        _ => Err(KernelError::validation(
            "latitude and longitude must be provided together",
        )),
    }
}

/// Max code points for a site representative-contact name (담당자명). Matches the
/// `registry_sites_contact_name_max_chars` CHECK in migration 0040.
pub const CONTACT_NAME_MAX_CHARS: usize = 100;
/// Max code points for a site contact phone (연락처). Matches the
/// `registry_sites_contact_phone_max_chars` CHECK in migration 0040.
pub const CONTACT_PHONE_MAX_CHARS: usize = 40;
/// Max code points for a site contact email. Matches the
/// `registry_sites_contact_email_max_chars` CHECK in migration 0040.
pub const CONTACT_EMAIL_MAX_CHARS: usize = 320;

/// Reject text longer than `max_chars` Unicode code points (counted via
/// `chars()`, matching the DB CHECK's `char_length`). `field` names the offending
/// field in the error message; empty or short text passes. Returning a 422 here
/// keeps an over-long value from surfacing as a raw DB CHECK error.
///
/// # Errors
/// Returns `KernelError::validation` when `value` exceeds `max_chars`.
pub fn validate_bounded_text(
    value: &str,
    max_chars: usize,
    field: &str,
) -> Result<(), KernelError> {
    if value.chars().count() > max_chars {
        return Err(KernelError::validation(format!(
            "{field} must be at most {max_chars} characters"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_in_range_coordinates() {
        // Seoul City Hall — a real coordinate within both ranges.
        assert!(validate_latitude(37.5665).is_ok());
        assert!(validate_longitude(126.9780).is_ok());
        assert!(validate_latitude(LATITUDE_MIN).is_ok());
        assert!(validate_latitude(LATITUDE_MAX).is_ok());
        assert!(validate_longitude(LONGITUDE_MIN).is_ok());
        assert!(validate_longitude(LONGITUDE_MAX).is_ok());
    }

    #[test]
    fn rejects_out_of_range_coordinates() {
        assert!(validate_latitude(90.0001).is_err());
        assert!(validate_latitude(-90.0001).is_err());
        assert!(validate_longitude(180.0001).is_err());
        assert!(validate_longitude(-180.0001).is_err());
    }

    #[test]
    fn rejects_non_finite_coordinates() {
        assert!(validate_latitude(f64::NAN).is_err());
        assert!(validate_latitude(f64::INFINITY).is_err());
        assert!(validate_longitude(f64::NEG_INFINITY).is_err());
    }

    #[test]
    fn coordinate_pair_must_be_complete() {
        assert!(validate_coordinate_pair(Some(37.5), Some(127.0)).is_ok());
        assert!(validate_coordinate_pair(None, None).is_ok());
        assert!(validate_coordinate_pair(Some(37.5), None).is_err());
        assert!(validate_coordinate_pair(None, Some(127.0)).is_err());
        // A complete pair with one out-of-range value still fails.
        assert!(validate_coordinate_pair(Some(999.0), Some(127.0)).is_err());
    }

    #[test]
    fn bounded_text_counts_code_points_not_bytes() {
        assert!(validate_bounded_text("홍길동", CONTACT_NAME_MAX_CHARS, "contact_name").is_ok());
        assert!(validate_bounded_text("", CONTACT_PHONE_MAX_CHARS, "contact_phone").is_ok());
        // Exactly the bound (100 Hangul chars = 300 bytes) passes a 100-char limit.
        let exactly: String = "가".repeat(CONTACT_NAME_MAX_CHARS);
        assert!(validate_bounded_text(&exactly, CONTACT_NAME_MAX_CHARS, "contact_name").is_ok());
        let too_long: String = "가".repeat(CONTACT_NAME_MAX_CHARS + 1);
        assert!(validate_bounded_text(&too_long, CONTACT_NAME_MAX_CHARS, "contact_name").is_err());
    }
}
