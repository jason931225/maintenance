use mnt_gate_migration_safety::{ViolationKind, check_migrations_root};
use std::fs;
use std::path::{Path, PathBuf};

fn temp_workspace(name: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let dir = std::env::temp_dir().join(format!(
        "mnt-migration-gate-test-{name}-{}",
        std::process::id()
    ));
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
fn gate_rejects_drop_table_on_audited_table() -> Result<(), Box<dyn std::error::Error>> {
    let ws = temp_workspace("drop-table")?;
    write_file(
        &ws.join("crates/platform/db/migrations/0001_bad.sql"),
        r#"
-- mnt-gate: audited-table work_orders
DROP TABLE IF EXISTS work_orders;
"#,
    )?;

    let result = check_migrations_root(&ws);
    assert!(!result.passed(), "expected DROP TABLE violation");
    assert!(
        result
            .violations
            .iter()
            .any(|v| v.kind == ViolationKind::DropAuditedTable),
        "expected DropAuditedTable, got {:#?}",
        result.violations
    );
    Ok(())
}

#[test]
fn gate_rejects_drop_table_on_built_in_audited_table_without_marker()
-> Result<(), Box<dyn std::error::Error>> {
    let ws = temp_workspace("drop-built-in-table")?;
    write_file(
        &ws.join("crates/platform/db/migrations/0001_bad.sql"),
        "DROP TABLE users;\n",
    )?;

    let result = check_migrations_root(&ws);
    assert!(
        !result.passed(),
        "expected built-in audited table violation"
    );
    assert!(
        result
            .violations
            .iter()
            .any(|v| v.kind == ViolationKind::DropAuditedTable),
        "expected DropAuditedTable, got {:#?}",
        result.violations
    );
    Ok(())
}

#[test]
fn gate_rejects_drop_column_on_audited_table() -> Result<(), Box<dyn std::error::Error>> {
    let ws = temp_workspace("drop-column")?;
    write_file(
        &ws.join("crates/platform/db/migrations/0001_bad.sql"),
        r#"
-- mnt-gate: audited-table work_orders
ALTER TABLE work_orders DROP COLUMN status;
"#,
    )?;

    let result = check_migrations_root(&ws);
    assert!(!result.passed(), "expected DROP COLUMN violation");
    assert!(
        result
            .violations
            .iter()
            .any(|v| v.kind == ViolationKind::DropAuditedColumn),
        "expected DropAuditedColumn, got {:#?}",
        result.violations
    );
    Ok(())
}

#[test]
fn gate_rejects_update_or_delete_grants_on_audit_events() -> Result<(), Box<dyn std::error::Error>>
{
    let ws = temp_workspace("grant")?;
    write_file(
        &ws.join("crates/platform/db/migrations/0001_bad.sql"),
        "GRANT SELECT, UPDATE, DELETE ON TABLE audit_events TO app_user;\n",
    )?;

    let result = check_migrations_root(&ws);
    assert!(!result.passed(), "expected GRANT mutation violation");
    assert!(
        result
            .violations
            .iter()
            .any(|v| v.kind == ViolationKind::GrantAuditEventsMutation),
        "expected GrantAuditEventsMutation, got {:#?}",
        result.violations
    );
    Ok(())
}

#[test]
fn gate_rejects_disable_trigger_on_audit_events() -> Result<(), Box<dyn std::error::Error>> {
    let ws = temp_workspace("disable-trigger")?;
    write_file(
        &ws.join("crates/platform/db/migrations/0001_bad.sql"),
        "ALTER TABLE audit_events DISABLE TRIGGER trg_audit_events_no_update;\n",
    )?;

    let result = check_migrations_root(&ws);
    assert!(!result.passed(), "expected DISABLE TRIGGER violation");
    assert!(
        result
            .violations
            .iter()
            .any(|v| v.kind == ViolationKind::DisableAuditEventsTrigger),
        "expected DisableAuditEventsTrigger, got {:#?}",
        result.violations
    );
    Ok(())
}

#[test]
fn gate_passes_safe_migration() -> Result<(), Box<dyn std::error::Error>> {
    let ws = temp_workspace("safe")?;
    write_file(
        &ws.join("crates/platform/db/migrations/0001_safe.sql"),
        r#"
CREATE TABLE work_orders (
    id UUID PRIMARY KEY,
    status TEXT NOT NULL
);
GRANT SELECT ON TABLE audit_events TO app_user;
"#,
    )?;

    let result = check_migrations_root(&ws);
    assert!(
        result.passed(),
        "expected safe migration to pass, got {:#?}",
        result.violations
    );
    Ok(())
}
