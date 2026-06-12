//! Layer-boundary gate: enforces clean-architecture dependency direction
//! and manifest hygiene across the Cargo workspace.
//!
//! Allowed dependency direction (workspace crates only):
//!   kernel → (nothing)
//!   domain → kernel
//!   application → domain, kernel
//!   adapter/platform → application, domain, kernel
//!   rest/worker → adapter, platform, application, domain, kernel
//!   app → everything
//!   gate → (exempt from layer checks)
//!
//! Purity rule: domain and application crates may NOT depend on sqlx, axum, or tokio.
//!
//! Manifest hygiene:
//!   - Every workspace crate name starts with `mnt-`
//!   - Every crate uses `edition.workspace = true` (edition equals workspace edition "2024")
//!   - publish = false (inherited)
//!   - [lints] workspace = true present in each Cargo.toml

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Deserialize;

// ---------------------------------------------------------------------------
// Cargo metadata types (subset we need)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct Metadata {
    pub workspace_root: String,
    pub workspace_members: Vec<String>,
    pub packages: Vec<Package>,
    pub workspace_packages: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Package {
    pub id: String,
    pub name: String,
    pub manifest_path: String,
    pub edition: String,
    pub dependencies: Vec<Dependency>,
    // publish is a Vec<String> (registry list) or null when publish=false
    // We parse it as raw JSON value to handle both cases.
    pub publish: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Dependency {
    pub name: String,
    pub path: Option<String>,
    pub kind: Option<String>,
}

// ---------------------------------------------------------------------------
// Layer classification
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Layer {
    Kernel,
    Domain,
    Application,
    Adapter,  // includes platform (adapter-equivalent)
    Platform, // crates/platform/* — adapter-layer privileges
    Rest,
    Worker,
    App,
    Gate, // exempt from layer checks
}

impl Layer {
    pub fn name(&self) -> &'static str {
        match self {
            Layer::Kernel => "kernel",
            Layer::Domain => "domain",
            Layer::Application => "application",
            Layer::Adapter => "adapter",
            Layer::Platform => "platform",
            Layer::Rest => "rest",
            Layer::Worker => "worker",
            Layer::App => "app",
            Layer::Gate => "gate",
        }
    }

    /// Layers that this layer is allowed to depend on (workspace crates only).
    pub fn allowed_deps(&self) -> &'static [Layer] {
        match self {
            Layer::Kernel => &[],
            Layer::Domain => &[Layer::Kernel],
            Layer::Application => &[Layer::Domain, Layer::Kernel],
            // adapter and platform have the same dependency privileges
            Layer::Adapter | Layer::Platform => &[
                Layer::Application,
                Layer::Domain,
                Layer::Kernel,
                Layer::Platform,
            ],
            Layer::Rest | Layer::Worker => &[
                Layer::Adapter,
                Layer::Platform,
                Layer::Application,
                Layer::Domain,
                Layer::Kernel,
            ],
            Layer::App => &[
                Layer::Kernel,
                Layer::Domain,
                Layer::Application,
                Layer::Adapter,
                Layer::Platform,
                Layer::Rest,
                Layer::Worker,
                Layer::App,
                Layer::Gate,
            ],
            Layer::Gate => &[], // gates are exempt — no layer restriction
        }
    }

    /// External crates that domain/application may not depend on (purity rule).
    pub fn forbidden_external_deps(&self) -> &'static [&'static str] {
        match self {
            Layer::Domain | Layer::Application => &["sqlx", "axum", "tokio"],
            _ => &[],
        }
    }
}

/// Classify a workspace crate by its manifest path and name.
/// `manifest_path` is absolute; `workspace_root` is the workspace root dir.
pub fn classify_crate(name: &str, manifest_path: &str, workspace_root: &str) -> Layer {
    // Make path relative to workspace root for pattern matching.
    let rel = manifest_path
        .strip_prefix(workspace_root)
        .unwrap_or(manifest_path)
        .trim_start_matches('/');

    // ci/gates/* → gate
    if rel.starts_with("ci/gates/") {
        return Layer::Gate;
    }

    // app → App
    if rel.starts_with("app/") || rel == "app/Cargo.toml" {
        return Layer::App;
    }

    // crates/kernel/* → Kernel
    if rel.starts_with("crates/kernel/") {
        return Layer::Kernel;
    }

    // crates/platform/* → Platform
    if rel.starts_with("crates/platform/") {
        return Layer::Platform;
    }

    // For crates/*, classify by name suffix
    // mnt-*-domain
    if name.ends_with("-domain") {
        return Layer::Domain;
    }
    // mnt-*-application
    if name.ends_with("-application") {
        return Layer::Application;
    }
    // mnt-*-adapter-* (e.g. mnt-workorder-adapter-postgres)
    if name.contains("-adapter-") {
        return Layer::Adapter;
    }
    // mnt-*-rest
    if name.ends_with("-rest") {
        return Layer::Rest;
    }
    // mnt-*-worker
    if name.ends_with("-worker") {
        return Layer::Worker;
    }

    // Fallback: if path starts with crates/ and none of the above matched,
    // it's a generic platform/utility — treat as Adapter layer (conservative).
    Layer::Adapter
}

// ---------------------------------------------------------------------------
// Violations
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Violation {
    pub kind: ViolationKind,
    pub crate_name: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ViolationKind {
    IllegalLayerEdge,
    ForbiddenExternalDep,
    MissingMntPrefix,
    WrongEdition,
    MissingLintsWorkspace,
    ConflictMarker,
}

impl std::fmt::Display for Violation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let kind = match self.kind {
            ViolationKind::IllegalLayerEdge => "ILLEGAL_LAYER_EDGE",
            ViolationKind::ForbiddenExternalDep => "FORBIDDEN_EXTERNAL_DEP",
            ViolationKind::MissingMntPrefix => "MISSING_MNT_PREFIX",
            ViolationKind::WrongEdition => "WRONG_EDITION",
            ViolationKind::MissingLintsWorkspace => "MISSING_LINTS_WORKSPACE",
            ViolationKind::ConflictMarker => "CONFLICT_MARKER",
        };
        write!(f, "[{}] {}: {}", kind, self.crate_name, self.detail)
    }
}

// ---------------------------------------------------------------------------
// Gate result
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct GateResult {
    pub violations: Vec<Violation>,
}

impl GateResult {
    pub fn passed(&self) -> bool {
        self.violations.is_empty()
    }
}

// ---------------------------------------------------------------------------
// Conflict-marker scan (MFL-0001)
// ---------------------------------------------------------------------------

/// Scans the given files for unresolved git conflict markers. Binary files
/// (non-UTF-8) are skipped. Patterns are built at runtime so this source file
/// never contains a literal marker and cannot flag itself.
pub fn check_conflict_markers(files: &[PathBuf]) -> Vec<Violation> {
    let open = format!("{} ", "<".repeat(7));
    let close = format!("{} ", ">".repeat(7));
    let mut violations = Vec::new();

    for path in files {
        let Ok(content) = std::fs::read_to_string(path) else {
            continue; // binary or unreadable: not a text merge-conflict candidate
        };
        for (idx, line) in content.lines().enumerate() {
            if line.starts_with(&open) || line.starts_with(&close) {
                violations.push(Violation {
                    kind: ViolationKind::ConflictMarker,
                    crate_name: path.display().to_string(),
                    detail: format!("unresolved git conflict marker at line {}", idx + 1),
                });
            }
        }
    }
    violations
}

/// Lists git-tracked files for the repository containing `dir`.
pub fn git_tracked_files(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let root_out = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(dir)
        .output()
        .map_err(|e| format!("failed to run git rev-parse: {e}"))?;
    if !root_out.status.success() {
        return Err("git rev-parse --show-toplevel failed".to_owned());
    }
    let root = PathBuf::from(String::from_utf8_lossy(&root_out.stdout).trim().to_owned());

    let ls_out = std::process::Command::new("git")
        .args(["ls-files"])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("failed to run git ls-files: {e}"))?;
    if !ls_out.status.success() {
        return Err("git ls-files failed".to_owned());
    }
    Ok(String::from_utf8_lossy(&ls_out.stdout)
        .lines()
        .map(|l| root.join(l))
        .collect())
}

// ---------------------------------------------------------------------------
// Main check logic
// ---------------------------------------------------------------------------

/// Run all checks against already-parsed `Metadata`.
/// `workspace_edition` is the edition string declared in `[workspace.package]`
/// (e.g. "2024").
pub fn check(metadata: &Metadata, workspace_edition: &str) -> GateResult {
    // Build a map: package id → layer, and name → layer for workspace members.
    let workspace_member_ids: HashSet<&str> = metadata
        .workspace_members
        .iter()
        .map(|s| s.as_str())
        .collect();

    // Only consider workspace packages (filter by membership).
    let workspace_pkgs: Vec<&Package> = metadata
        .packages
        .iter()
        .filter(|p| workspace_member_ids.contains(p.id.as_str()))
        .collect();

    // name → layer map for workspace crates (for dependency edge checks).
    let name_to_layer: HashMap<&str, Layer> = workspace_pkgs
        .iter()
        .map(|p| {
            let layer = classify_crate(&p.name, &p.manifest_path, &metadata.workspace_root);
            (p.name.as_str(), layer)
        })
        .collect();

    let mut violations = Vec::new();

    for pkg in &workspace_pkgs {
        let layer = classify_crate(&pkg.name, &pkg.manifest_path, &metadata.workspace_root);

        // --- Manifest hygiene: mnt- prefix ---
        if !pkg.name.starts_with("mnt-") {
            violations.push(Violation {
                kind: ViolationKind::MissingMntPrefix,
                crate_name: pkg.name.clone(),
                detail: format!("name '{}' does not start with 'mnt-'", pkg.name),
            });
        }

        // --- Manifest hygiene: edition must equal workspace edition ---
        if pkg.edition != workspace_edition {
            violations.push(Violation {
                kind: ViolationKind::WrongEdition,
                crate_name: pkg.name.clone(),
                detail: format!(
                    "edition '{}' != workspace edition '{}' (use `edition.workspace = true`)",
                    pkg.edition, workspace_edition
                ),
            });
        }

        // --- Manifest hygiene: [lints] workspace = true ---
        // We check this by reading the raw Cargo.toml file.
        let manifest_path = PathBuf::from(&pkg.manifest_path);
        if !has_lints_workspace(&manifest_path) {
            violations.push(Violation {
                kind: ViolationKind::MissingLintsWorkspace,
                crate_name: pkg.name.clone(),
                detail: format!(
                    "{}: missing `[lints]\\nworkspace = true`",
                    pkg.manifest_path
                ),
            });
        }

        // --- Layer checks (gates are exempt) ---
        if layer == Layer::Gate {
            continue;
        }

        let allowed = layer.allowed_deps();
        let forbidden_external = layer.forbidden_external_deps();

        for dep in &pkg.dependencies {
            // Skip dev/build deps for layer-edge checks? No — we enforce on all.
            // (A domain crate pulling axum even in dev-dep is suspicious, but
            //  realistically test harnesses may need it. We'll scope to normal deps only.)
            let is_normal_dep = dep.kind.is_none(); // kind=None means normal dep

            if let Some(dep_layer) = name_to_layer.get(dep.name.as_str()) {
                // Workspace dependency — check layer edge.
                if is_normal_dep && !allowed.contains(dep_layer) {
                    violations.push(Violation {
                        kind: ViolationKind::IllegalLayerEdge,
                        crate_name: pkg.name.clone(),
                        detail: format!(
                            "{} ({}) → {} ({}) is forbidden",
                            pkg.name,
                            layer.name(),
                            dep.name,
                            dep_layer.name()
                        ),
                    });
                }
            } else {
                // External dependency — check purity rule.
                if is_normal_dep && forbidden_external.contains(&dep.name.as_str()) {
                    violations.push(Violation {
                        kind: ViolationKind::ForbiddenExternalDep,
                        crate_name: pkg.name.clone(),
                        detail: format!(
                            "{} ({}) depends on forbidden external crate '{}'",
                            pkg.name,
                            layer.name(),
                            dep.name
                        ),
                    });
                }
            }
        }
    }

    GateResult { violations }
}

/// Check whether a Cargo.toml file contains `[lints]\nworkspace = true`.
/// We read the file as text and look for the pattern rather than pulling in
/// a TOML parser (keeping deps minimal — serde_json is sufficient for metadata).
fn has_lints_workspace(manifest_path: &Path) -> bool {
    let Ok(content) = std::fs::read_to_string(manifest_path) else {
        // If we can't read it we can't verify — report as missing.
        return false;
    };
    // Accept either `workspace = true` or `workspace=true` under a [lints] section.
    // Simple state-machine: find [lints] header, then scan subsequent non-header
    // lines for workspace = true.
    let mut in_lints = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_lints = trimmed == "[lints]";
            continue;
        }
        if in_lints {
            // workspace = true (with optional spaces around =)
            let normalized: String = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
            if normalized == "workspace=true" {
                return true;
            }
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Invoke `cargo metadata` and parse
// ---------------------------------------------------------------------------

/// Run `cargo metadata --format-version 1 --no-deps` in `workspace_dir` and
/// parse the output.
///
/// Returns `(Metadata, workspace_edition)`.
pub fn load_metadata(workspace_dir: &Path) -> Result<(Metadata, String), String> {
    let output = std::process::Command::new("cargo")
        .args(["metadata", "--format-version", "1", "--no-deps"])
        .current_dir(workspace_dir)
        .output()
        .map_err(|e| format!("failed to run `cargo metadata`: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("`cargo metadata` failed:\n{stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let raw: serde_json::Value =
        serde_json::from_str(&stdout).map_err(|e| format!("failed to parse metadata JSON: {e}"))?;

    // Extract workspace edition from workspace_metadata or workspace packages.
    // The canonical source is `raw["workspace_metadata"]` but it may be absent.
    // More reliably: look at `raw["packages"]` for the root package edition,
    // or parse the workspace Cargo.toml directly.
    // We parse the workspace Cargo.toml for the workspace.package.edition.
    let workspace_root = raw["workspace_root"]
        .as_str()
        .ok_or("missing workspace_root in metadata")?
        .to_string();

    let workspace_edition = read_workspace_edition(Path::new(&workspace_root))?;

    let metadata: Metadata =
        serde_json::from_value(raw).map_err(|e| format!("failed to deserialize metadata: {e}"))?;

    Ok((metadata, workspace_edition))
}

/// Read the `edition` field from `[workspace.package]` in the root Cargo.toml.
fn read_workspace_edition(workspace_root: &Path) -> Result<String, String> {
    let cargo_toml = workspace_root.join("Cargo.toml");
    let content = std::fs::read_to_string(&cargo_toml)
        .map_err(|e| format!("cannot read {}: {e}", cargo_toml.display()))?;

    // Simple state-machine: find [workspace.package] header, then read `edition`.
    let mut in_section = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_section = trimmed == "[workspace.package]";
            continue;
        }
        if in_section && trimmed.starts_with("edition") {
            // edition = "2024"   or   edition = "2024"
            if let Some((_key, val)) = trimmed.split_once('=') {
                let edition = val.trim().trim_matches('"').to_string();
                return Ok(edition);
            }
        }
    }

    Err(format!(
        "could not find `edition` in [workspace.package] in {}",
        cargo_toml.display()
    ))
}

// ---------------------------------------------------------------------------
// Tests (unit)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_kernel() {
        assert_eq!(
            classify_crate(
                "mnt-kernel-core",
                "/ws/crates/kernel/core/Cargo.toml",
                "/ws"
            ),
            Layer::Kernel
        );
    }

    #[test]
    fn classify_domain() {
        assert_eq!(
            classify_crate(
                "mnt-workorder-domain",
                "/ws/crates/workorder/domain/Cargo.toml",
                "/ws"
            ),
            Layer::Domain
        );
    }

    #[test]
    fn classify_application() {
        assert_eq!(
            classify_crate(
                "mnt-workorder-application",
                "/ws/crates/workorder/application/Cargo.toml",
                "/ws"
            ),
            Layer::Application
        );
    }

    #[test]
    fn classify_adapter() {
        assert_eq!(
            classify_crate(
                "mnt-workorder-adapter-postgres",
                "/ws/crates/workorder/adapter-postgres/Cargo.toml",
                "/ws"
            ),
            Layer::Adapter
        );
    }

    #[test]
    fn classify_platform() {
        assert_eq!(
            classify_crate(
                "mnt-platform-auth",
                "/ws/crates/platform/auth/Cargo.toml",
                "/ws"
            ),
            Layer::Platform
        );
    }

    #[test]
    fn classify_rest() {
        assert_eq!(
            classify_crate(
                "mnt-workorder-rest",
                "/ws/crates/workorder/rest/Cargo.toml",
                "/ws"
            ),
            Layer::Rest
        );
    }

    #[test]
    fn classify_worker() {
        assert_eq!(
            classify_crate(
                "mnt-workorder-worker",
                "/ws/crates/workorder/worker/Cargo.toml",
                "/ws"
            ),
            Layer::Worker
        );
    }

    #[test]
    fn classify_gate() {
        assert_eq!(
            classify_crate(
                "mnt-gate-layer-boundary",
                "/ws/ci/gates/layer-boundary/Cargo.toml",
                "/ws"
            ),
            Layer::Gate
        );
    }

    #[test]
    fn classify_app() {
        assert_eq!(
            classify_crate("mnt-app", "/ws/app/Cargo.toml", "/ws"),
            Layer::App
        );
    }

    #[test]
    fn allowed_deps_kernel_is_empty() {
        assert!(Layer::Kernel.allowed_deps().is_empty());
    }

    #[test]
    fn allowed_deps_domain_only_kernel() {
        assert_eq!(Layer::Domain.allowed_deps(), &[Layer::Kernel]);
    }

    #[test]
    fn domain_forbidden_external() {
        let forbidden = Layer::Domain.forbidden_external_deps();
        assert!(forbidden.contains(&"sqlx"));
        assert!(forbidden.contains(&"axum"));
        assert!(forbidden.contains(&"tokio"));
    }

    #[test]
    fn gate_allowed_everything() {
        // Gate layer is exempt — its allowed_deps() is empty but it is not
        // checked in the gate loop. Just confirm the classify works.
        assert_eq!(
            classify_crate("mnt-gate-foo", "/ws/ci/gates/foo/Cargo.toml", "/ws"),
            Layer::Gate
        );
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod conflict_marker_tests {
    use super::*;

    fn write_temp(name: &str, content: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("mnt-gate-marker-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn flags_files_containing_markers_and_passes_clean_files() {
        let open_marker = format!("{} HEAD\nbody\n", "<".repeat(7));
        let close_marker = format!("ok\n{} branch-x\n", ">".repeat(7));
        let dirty_open = write_temp("dirty_open.toml", &open_marker);
        let dirty_close = write_temp("dirty_close.rs", &close_marker);
        // "=======" alone must NOT be flagged (legit markdown/separator usage).
        let clean = write_temp("clean.md", "title\n=======\nbody with <<< and >>> short\n");

        let violations = check_conflict_markers(&[dirty_open.clone(), dirty_close.clone(), clean]);
        assert_eq!(violations.len(), 2, "{violations:#?}");
        assert!(
            violations
                .iter()
                .all(|v| v.kind == ViolationKind::ConflictMarker)
        );
        assert!(
            violations
                .iter()
                .any(|v| v.crate_name.contains("dirty_open"))
        );
        assert!(
            violations
                .iter()
                .any(|v| v.crate_name.contains("dirty_close"))
        );
    }

    #[test]
    fn skips_non_utf8_binary_files() {
        let dir = std::env::temp_dir().join("mnt-gate-marker-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("binary.bin");
        std::fs::write(&path, [0u8, 159, 146, 150, 255]).unwrap();
        assert!(check_conflict_markers(&[path]).is_empty());
    }

    #[test]
    fn real_repo_tracked_files_are_marker_free() {
        let cwd = std::env::current_dir().unwrap();
        let files = git_tracked_files(&cwd).unwrap();
        assert!(files.len() > 50, "expected a real tracked file list");
        let violations = check_conflict_markers(&files);
        assert!(violations.is_empty(), "{violations:#?}");
    }
}
