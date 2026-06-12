use mnt_gate_pii_no_logs::{ViolationKind, check_source_tree};
use std::fs;
use std::path::{Path, PathBuf};

fn temp_workspace(name: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let dir = std::env::temp_dir().join(format!("mnt-pii-gate-test-{name}-{}", std::process::id()));
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn write_file(path: &Path, content: &str) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, content)?;
    Ok(())
}

#[test]
fn gate_flags_korean_phone_number_in_tracing_macro() -> Result<(), Box<dyn std::error::Error>> {
    let ws = temp_workspace("phone")?;
    write_file(
        &ws.join("src/lib.rs"),
        r#"
pub fn log_phone() {
    tracing::info!("driver phone 010-1234-5678");
}
"#,
    )?;

    let result = check_source_tree(&ws);
    assert!(!result.passed(), "expected phone-number violation");
    assert!(
        result
            .violations
            .iter()
            .any(|v| v.kind == ViolationKind::KoreanPhoneNumber),
        "expected KoreanPhoneNumber, got {:#?}",
        result.violations
    );
    Ok(())
}

#[test]
fn gate_flags_gps_coordinate_pair_in_log_macro() -> Result<(), Box<dyn std::error::Error>> {
    let ws = temp_workspace("gps")?;
    write_file(
        &ws.join("src/lib.rs"),
        r#"
pub fn log_coords() {
    log::warn!("raw coordinate pair 37.5665, 126.9780");
}
"#,
    )?;

    let result = check_source_tree(&ws);
    assert!(!result.passed(), "expected GPS coordinate violation");
    assert!(
        result
            .violations
            .iter()
            .any(|v| v.kind == ViolationKind::GpsCoordinatePair),
        "expected GpsCoordinatePair, got {:#?}",
        result.violations
    );
    Ok(())
}

#[test]
fn gate_flags_longitude_first_gps_coordinate_pair_in_log_macro()
-> Result<(), Box<dyn std::error::Error>> {
    let ws = temp_workspace("gps-lon-lat")?;
    write_file(
        &ws.join("src/lib.rs"),
        r#"
pub fn log_coords() {
    log::warn!("raw coordinate pair 126.9780, 37.5665");
}
"#,
    )?;

    let result = check_source_tree(&ws);
    assert!(
        !result.passed(),
        "expected longitude-first GPS coordinate violation"
    );
    assert!(
        result
            .violations
            .iter()
            .any(|v| v.kind == ViolationKind::GpsCoordinatePair),
        "expected GpsCoordinatePair, got {:#?}",
        result.violations
    );
    Ok(())
}

#[test]
fn gate_flags_resident_registration_number_in_bare_log_macro()
-> Result<(), Box<dyn std::error::Error>> {
    let ws = temp_workspace("rrn")?;
    write_file(
        &ws.join("src/lib.rs"),
        r#"
pub fn log_rrn() {
    info!("resident id 900101-1234567");
}
"#,
    )?;

    let result = check_source_tree(&ws);
    assert!(!result.passed(), "expected RRN violation");
    assert!(
        result
            .violations
            .iter()
            .any(|v| v.kind == ViolationKind::ResidentRegistrationNumber),
        "expected ResidentRegistrationNumber, got {:#?}",
        result.violations
    );
    Ok(())
}

#[test]
fn gate_ignores_pii_outside_log_macro_calls() -> Result<(), Box<dyn std::error::Error>> {
    let ws = temp_workspace("outside")?;
    write_file(
        &ws.join("src/lib.rs"),
        r#"
const FIXTURE_PHONE: &str = "010-1234-5678";

pub fn no_log() {
    let _ = FIXTURE_PHONE;
}
"#,
    )?;

    let result = check_source_tree(&ws);
    assert!(
        result.passed(),
        "expected non-log fixture to pass, got {:#?}",
        result.violations
    );
    Ok(())
}
