use mnt_gate_audit_coverage::{ViolationKind, allowed_audit_exclusions, check_source_tree};
use std::fs;
use std::path::{Path, PathBuf};

fn temp_workspace(name: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let dir =
        std::env::temp_dir().join(format!("mnt-audit-gate-test-{name}-{}", std::process::id()));
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
fn allowed_exclusion_set_contains_only_location_ping_ingestion() {
    let exclusions = allowed_audit_exclusions();
    assert_eq!(exclusions.len(), 1);
    assert_eq!(exclusions[0].reason, "location_ping_ingestion");
    assert_eq!(exclusions[0].path, "LocationPing ingestion path");
}

#[test]
fn gate_fails_state_changing_handler_without_audit() -> Result<(), Box<dyn std::error::Error>> {
    let ws = temp_workspace("missing-audit")?;
    write_file(
        &ws.join("crates/workorder/rest/src/lib.rs"),
        r#"
// mnt-gate: state-changing-handler
pub async fn approve_work_order(pool: &PgPool, id: WorkOrderId) {
    sqlx::query!("UPDATE work_orders SET status = 'APPROVED' WHERE id = $1", id)
        .execute(pool)
        .await;
}
"#,
    )?;

    let result = check_source_tree(&ws);
    assert!(!result.passed(), "expected missing audit violation");
    assert!(
        result
            .violations
            .iter()
            .any(|v| v.kind == ViolationKind::MissingAuditEvent),
        "expected MissingAuditEvent, got {:#?}",
        result.violations
    );
    Ok(())
}

#[test]
fn gate_fails_unmarked_mutating_rest_handler() -> Result<(), Box<dyn std::error::Error>> {
    let ws = temp_workspace("unmarked-mutation")?;
    write_file(
        &ws.join("crates/workorder/rest/src/lib.rs"),
        r#"
pub async fn approve_work_order(pool: &PgPool, id: WorkOrderId) {
    sqlx::query!("UPDATE work_orders SET status = 'APPROVED' WHERE id = $1", id)
        .execute(pool)
        .await;
}
"#,
    )?;

    let result = check_source_tree(&ws);
    assert!(
        !result.passed(),
        "expected unmarked mutating REST handler violation"
    );
    assert!(
        result
            .violations
            .iter()
            .any(|v| v.kind == ViolationKind::MissingAuditEvent),
        "expected MissingAuditEvent, got {:#?}",
        result.violations
    );
    Ok(())
}

#[test]
fn gate_does_not_accept_audit_words_in_comments() -> Result<(), Box<dyn std::error::Error>> {
    let ws = temp_workspace("comment-only-audit")?;
    write_file(
        &ws.join("crates/workorder/rest/src/lib.rs"),
        r#"
// mnt-gate: state-changing-handler
pub async fn approve_work_order(pool: &PgPool, id: WorkOrderId) {
    // TODO: add with_audit and AuditEvent later.
    sqlx::query!("UPDATE work_orders SET status = 'APPROVED' WHERE id = $1", id)
        .execute(pool)
        .await;
}
"#,
    )?;

    let result = check_source_tree(&ws);
    assert!(
        !result.passed(),
        "expected comment-only audit words to be rejected"
    );
    assert!(
        result
            .violations
            .iter()
            .any(|v| v.kind == ViolationKind::MissingAuditEvent),
        "expected MissingAuditEvent, got {:#?}",
        result.violations
    );
    Ok(())
}

#[test]
fn gate_passes_state_changing_handler_with_audit() -> Result<(), Box<dyn std::error::Error>> {
    let ws = temp_workspace("with-audit")?;
    write_file(
        &ws.join("crates/workorder/rest/src/lib.rs"),
        r#"
// mnt-gate: state-changing-handler
pub async fn approve_work_order(pool: &PgPool) {
    let event = AuditEvent::new(
        Some(actor),
        action,
        "work_order",
        id,
        trace,
        occurred_at,
    );
    with_audit(pool, event, |tx| Box::pin(async move {
        sqlx::query!("UPDATE work_orders SET status = 'APPROVED' WHERE id = $1", id)
            .execute(tx.as_mut())
            .await?;
        Ok(())
    })).await
}
"#,
    )?;

    let result = check_source_tree(&ws);
    assert!(
        result.passed(),
        "expected audited handler to pass, got {:#?}",
        result.violations
    );
    Ok(())
}

#[test]
fn gate_allows_exactly_one_location_ping_exemption() -> Result<(), Box<dyn std::error::Error>> {
    let ws = temp_workspace("location-exemption")?;
    write_file(
        &ws.join("crates/compliance/rest/src/lib.rs"),
        r#"
// mnt-gate: state-changing-handler
// mnt-gate: audit-exempt location_ping_ingestion
pub async fn ingest_location_ping(pool: &PgPool, ping: LocationPing) {
    sqlx::query!("INSERT INTO location_pings (user_id, lat, lon) VALUES ($1, $2, $3)")
        .execute(pool)
        .await;
}
"#,
    )?;

    let result = check_source_tree(&ws);
    assert!(
        result.passed(),
        "expected LocationPing carve-out to pass, got {:#?}",
        result.violations
    );
    assert_eq!(result.observed_exclusions.len(), 1);
    assert_eq!(
        result.observed_exclusions[0].reason,
        "location_ping_ingestion"
    );
    Ok(())
}

#[test]
fn gate_rejects_unknown_audit_exemption() -> Result<(), Box<dyn std::error::Error>> {
    let ws = temp_workspace("unknown-exemption")?;
    write_file(
        &ws.join("crates/workorder/rest/src/lib.rs"),
        r#"
// mnt-gate: state-changing-handler
// mnt-gate: audit-exempt temporary_backfill
pub async fn backfill_work_order(pool: &PgPool) {
    sqlx::query!("UPDATE work_orders SET status = 'APPROVED'")
        .execute(pool)
        .await;
}
"#,
    )?;

    let result = check_source_tree(&ws);
    assert!(!result.passed(), "expected unknown exemption violation");
    assert!(
        result
            .violations
            .iter()
            .any(|v| v.kind == ViolationKind::UnknownAuditExclusion),
        "expected UnknownAuditExclusion, got {:#?}",
        result.violations
    );
    Ok(())
}
