//! CI entry point for the layer-boundary gate.
//! Exits 0 on success, 1 on any violation.

use std::path::Path;

fn main() {
    // Default: check the workspace containing this binary's Cargo workspace.
    // In CI we run `cargo run -p mnt-gate-layer-boundary` from `backend/`.
    let workspace_dir = match std::env::current_dir() {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("ERROR: cannot determine cwd: {e}");
            std::process::exit(1);
        }
    };
    run_gate(&workspace_dir);
}

fn run_gate(workspace_dir: &Path) {
    eprintln!(
        "mnt-gate-layer-boundary: checking workspace at {}",
        workspace_dir.display()
    );

    let (metadata, workspace_edition) = mnt_gate_layer_boundary::load_metadata(workspace_dir)
        .unwrap_or_else(|e| {
            eprintln!("ERROR: {e}");
            std::process::exit(1);
        });

    let result = mnt_gate_layer_boundary::check(&metadata, &workspace_edition);

    if result.passed() {
        eprintln!(
            "mnt-gate-layer-boundary: PASSED — {} workspace crates checked, 0 violations",
            metadata.workspace_members.len()
        );
        std::process::exit(0);
    }

    eprintln!(
        "mnt-gate-layer-boundary: FAILED — {} violation(s):",
        result.violations.len()
    );
    for v in &result.violations {
        eprintln!("  {v}");
    }
    std::process::exit(1);
}
