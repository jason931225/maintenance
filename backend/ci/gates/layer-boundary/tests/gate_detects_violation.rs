//! Integration tests: create throwaway Cargo workspaces in std::env::temp_dir(),
//! run the gate's check logic against them, and assert red/green behavior.
//!
//! Tests return `Result<(), Box<dyn std::error::Error>>` so they can use `?`
//! without triggering the `expect_used` / `unwrap_used` / `panic` lints.

use mnt_gate_layer_boundary::{Layer, ViolationKind, check, classify_crate, load_metadata};
use std::fs;
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn temp_workspace(name: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let dir = std::env::temp_dir().join(format!("mnt-gate-test-{name}-{}", std::process::id()));
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn write_file(path: &std::path::Path, content: &str) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, content)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Red case: domain → adapter (illegal edge)
// ---------------------------------------------------------------------------

#[test]
fn gate_detects_domain_depends_on_adapter() -> Result<(), Box<dyn std::error::Error>> {
    let ws = temp_workspace("red")?;

    // Workspace Cargo.toml
    write_file(
        &ws.join("Cargo.toml"),
        r#"
[workspace]
resolver = "3"
members = ["crates/demo/domain", "crates/demo/adapter-postgres"]

[workspace.package]
edition = "2024"
publish = false

[workspace.lints.rust]
unsafe_code = "forbid"
"#,
    )?;

    // mnt-demo-adapter-postgres (adapter layer)
    let adapter_dir = ws.join("crates/demo/adapter-postgres");
    write_file(
        &adapter_dir.join("Cargo.toml"),
        r#"
[package]
name = "mnt-demo-adapter-postgres"
version = "0.1.0"
edition.workspace = true
publish.workspace = true

[lints]
workspace = true
"#,
    )?;
    write_file(&adapter_dir.join("src/lib.rs"), "// adapter placeholder\n")?;

    // mnt-demo-domain (domain layer) — ILLEGALLY depends on the adapter
    let domain_dir = ws.join("crates/demo/domain");
    write_file(
        &domain_dir.join("Cargo.toml"),
        r#"
[package]
name = "mnt-demo-domain"
version = "0.1.0"
edition.workspace = true
publish.workspace = true

[dependencies]
mnt-demo-adapter-postgres = { path = "../adapter-postgres" }

[lints]
workspace = true
"#,
    )?;
    write_file(&domain_dir.join("src/lib.rs"), "// domain placeholder\n")?;

    let (metadata, edition) = load_metadata(&ws)?;
    let result = check(&metadata, &edition);

    assert!(
        !result.passed(),
        "expected gate to FAIL for domain→adapter edge, but it passed"
    );

    let has_illegal_edge = result
        .violations
        .iter()
        .any(|v| v.kind == ViolationKind::IllegalLayerEdge);
    assert!(
        has_illegal_edge,
        "expected an IllegalLayerEdge violation, got: {:#?}",
        result.violations
    );

    // Find the edge violation and check it names the domain crate
    let edge_violation = result
        .violations
        .iter()
        .find(|v| v.kind == ViolationKind::IllegalLayerEdge);
    assert!(
        edge_violation.is_some(),
        "should have an IllegalLayerEdge violation"
    );
    if let Some(ev) = edge_violation {
        assert_eq!(
            ev.crate_name, "mnt-demo-domain",
            "violation should be on the domain crate"
        );
    }

    eprintln!("RED case violations: {:#?}", result.violations);
    Ok(())
}

// ---------------------------------------------------------------------------
// Green case: legal edges only (kernel ← domain ← application)
// ---------------------------------------------------------------------------

#[test]
fn gate_passes_legal_edges() -> Result<(), Box<dyn std::error::Error>> {
    let ws = temp_workspace("green")?;

    write_file(
        &ws.join("Cargo.toml"),
        r#"
[workspace]
resolver = "3"
members = [
    "crates/kernel/core",
    "crates/demo/domain",
    "crates/demo/application",
]

[workspace.package]
edition = "2024"
publish = false

[workspace.lints.rust]
unsafe_code = "forbid"
"#,
    )?;

    // mnt-kernel-core
    let kernel_dir = ws.join("crates/kernel/core");
    write_file(
        &kernel_dir.join("Cargo.toml"),
        r#"
[package]
name = "mnt-kernel-core"
version = "0.1.0"
edition.workspace = true
publish.workspace = true

[lints]
workspace = true
"#,
    )?;
    write_file(&kernel_dir.join("src/lib.rs"), "// kernel\n")?;

    // mnt-demo-domain → mnt-kernel-core (legal)
    let domain_dir = ws.join("crates/demo/domain");
    write_file(
        &domain_dir.join("Cargo.toml"),
        r#"
[package]
name = "mnt-demo-domain"
version = "0.1.0"
edition.workspace = true
publish.workspace = true

[dependencies]
mnt-kernel-core = { path = "../../kernel/core" }

[lints]
workspace = true
"#,
    )?;
    write_file(&domain_dir.join("src/lib.rs"), "// domain\n")?;

    // mnt-demo-application → mnt-demo-domain (legal)
    let app_dir = ws.join("crates/demo/application");
    write_file(
        &app_dir.join("Cargo.toml"),
        r#"
[package]
name = "mnt-demo-application"
version = "0.1.0"
edition.workspace = true
publish.workspace = true

[dependencies]
mnt-demo-domain = { path = "../domain" }
mnt-kernel-core = { path = "../../kernel/core" }

[lints]
workspace = true
"#,
    )?;
    write_file(&app_dir.join("src/lib.rs"), "// application\n")?;

    let (metadata, edition) = load_metadata(&ws)?;
    let result = check(&metadata, &edition);

    assert!(
        result.passed(),
        "expected gate to PASS for legal edges, but got violations: {:#?}",
        result.violations
    );

    eprintln!("GREEN case: PASSED with 0 violations");
    Ok(())
}

// ---------------------------------------------------------------------------
// Purity rule: domain layer forbids sqlx/axum/tokio as external deps
// (Validated via classify + forbidden_external_deps; no real dep resolution
//  needed — the gate enforces this at metadata parse time.)
// ---------------------------------------------------------------------------

#[test]
fn gate_detects_domain_depending_on_sqlx() {
    let layer = classify_crate(
        "mnt-workorder-domain",
        "/fake/ws/crates/workorder/domain/Cargo.toml",
        "/fake/ws",
    );
    assert_eq!(layer, Layer::Domain);
    let forbidden = layer.forbidden_external_deps();
    assert!(
        forbidden.contains(&"sqlx"),
        "domain should forbid sqlx; got {forbidden:?}"
    );
    assert!(
        forbidden.contains(&"axum"),
        "domain should forbid axum; got {forbidden:?}"
    );
    assert!(
        forbidden.contains(&"tokio"),
        "domain should forbid tokio; got {forbidden:?}"
    );
}

// ---------------------------------------------------------------------------
// Manifest hygiene: missing mnt- prefix is detected
// ---------------------------------------------------------------------------

#[test]
fn gate_detects_missing_mnt_prefix() -> Result<(), Box<dyn std::error::Error>> {
    let ws = temp_workspace("prefix")?;

    write_file(
        &ws.join("Cargo.toml"),
        r#"
[workspace]
resolver = "3"
members = ["crates/kernel/core"]

[workspace.package]
edition = "2024"
publish = false

[workspace.lints.rust]
unsafe_code = "forbid"
"#,
    )?;

    let kernel_dir = ws.join("crates/kernel/core");
    write_file(
        &kernel_dir.join("Cargo.toml"),
        r#"
[package]
name = "kernel-core"
version = "0.1.0"
edition.workspace = true
publish.workspace = true

[lints]
workspace = true
"#,
    )?;
    write_file(&kernel_dir.join("src/lib.rs"), "// kernel\n")?;

    let (metadata, edition) = load_metadata(&ws)?;
    let result = check(&metadata, &edition);

    let has_prefix_violation = result
        .violations
        .iter()
        .any(|v| v.kind == ViolationKind::MissingMntPrefix);
    assert!(
        has_prefix_violation,
        "expected MissingMntPrefix violation, got: {:#?}",
        result.violations
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Manifest hygiene: missing publish=false convention is detected
// ---------------------------------------------------------------------------

#[test]
fn gate_detects_missing_publish_false_convention() -> Result<(), Box<dyn std::error::Error>> {
    let ws = temp_workspace("publish")?;

    write_file(
        &ws.join("Cargo.toml"),
        r#"
[workspace]
resolver = "3"
members = ["crates/kernel/core"]

[workspace.package]
edition = "2024"
publish = false

[workspace.lints.rust]
unsafe_code = "forbid"
"#,
    )?;

    let kernel_dir = ws.join("crates/kernel/core");
    write_file(
        &kernel_dir.join("Cargo.toml"),
        r#"
[package]
name = "mnt-kernel-core"
version = "0.1.0"
edition.workspace = true

[lints]
workspace = true
"#,
    )?;
    write_file(&kernel_dir.join("src/lib.rs"), "// kernel\n")?;

    let (metadata, edition) = load_metadata(&ws)?;
    let result = check(&metadata, &edition);

    assert!(
        !result.passed(),
        "expected missing publish=false convention to fail, but gate passed"
    );
    assert_eq!(
        result.violations.len(),
        1,
        "missing publish=false fixture should fail only for the intended manifest hygiene rule; got: {:#?}",
        result.violations
    );
    let violation = &result.violations[0];
    assert_eq!(
        violation.kind,
        ViolationKind::MissingPublishFalse,
        "expected MissingPublishFalse violation, got: {:#?}",
        result.violations
    );
    assert_eq!(
        violation.crate_name, "mnt-kernel-core",
        "violation should be scoped to the crate missing publish=false"
    );
    assert!(
        violation.detail.contains("publish = false"),
        "expected publish=false diagnostic, got: {:#?}",
        result.violations
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Manifest hygiene: missing [lints] workspace = true is detected
// ---------------------------------------------------------------------------

#[test]
fn gate_detects_missing_lints_workspace() -> Result<(), Box<dyn std::error::Error>> {
    let ws = temp_workspace("lints")?;

    write_file(
        &ws.join("Cargo.toml"),
        r#"
[workspace]
resolver = "3"
members = ["crates/kernel/core"]

[workspace.package]
edition = "2024"
publish = false

[workspace.lints.rust]
unsafe_code = "forbid"
"#,
    )?;

    let kernel_dir = ws.join("crates/kernel/core");
    // Deliberately omit [lints] section
    write_file(
        &kernel_dir.join("Cargo.toml"),
        r#"
[package]
name = "mnt-kernel-core"
version = "0.1.0"
edition.workspace = true
publish.workspace = true
"#,
    )?;
    write_file(&kernel_dir.join("src/lib.rs"), "// kernel\n")?;

    let (metadata, edition) = load_metadata(&ws)?;
    let result = check(&metadata, &edition);

    let has_lints_violation = result
        .violations
        .iter()
        .any(|v| v.kind == ViolationKind::MissingLintsWorkspace);
    assert!(
        has_lints_violation,
        "expected MissingLintsWorkspace violation, got: {:#?}",
        result.violations
    );
    Ok(())
}
