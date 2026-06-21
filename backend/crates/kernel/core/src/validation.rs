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
}
