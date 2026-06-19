//! rls-arming gate.
//!
//! The application connects to Postgres as the non-owner `mnt_rt` role, which is
//! `NOBYPASSRLS` and subject to `FORCE ROW LEVEL SECURITY`. Every tenant-scoped
//! table's `org_isolation` policy keys on the per-transaction GUC
//! `app.current_org`, fail-closed (unset GUC -> zero rows / rejected writes). The
//! GUC is armed only inside `with_org_conn` / `with_audit` / `with_audits` (and
//! inside SECURITY DEFINER functions that `SET LOCAL row_security`). A query run
//! on a **bare pool** (`&self.pool`, `self.pool()`, `&pool`, `pool`) therefore
//! executes with no armed org and silently returns nothing in production while
//! passing CI (tests connect as a BYPASSRLS superuser).
//!
//! This gate forbids bare-pool query execution in the adapter/rest data layer.
//! After a read is wrapped in `with_org_conn`, its executor is `tx.as_mut()` and
//! no longer matches. The handful of legitimately-global, non-RLS reads
//! (`auth_rate_limit`, `auth_webauthn_ceremonies`, `_sqlx_migrations`, the
//! SECURITY DEFINER resolver bodies, health `SELECT 1`) must carry an inline
//! `// rls-arming: ok <reason>` marker so each exception is a deliberate,
//! reviewed decision rather than an accident.

use std::path::{Path, PathBuf};
use std::{collections::BTreeSet, fs};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    pub file: PathBuf,
    pub line: usize,
    pub detail: String,
}

impl std::fmt::Display for Violation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "[BarePoolQuery] {}:{}: {}",
            self.file.display(),
            self.line,
            self.detail
        )
    }
}

#[derive(Debug, Default)]
pub struct GateResult {
    pub violations: Vec<Violation>,
}

impl GateResult {
    #[must_use]
    pub fn passed(&self) -> bool {
        self.violations.is_empty()
    }
}

/// Query-executing method names whose executor argument we inspect.
const EXEC_METHODS: &[&str] = &[
    "fetch_all",
    "fetch_one",
    "fetch_optional",
    "fetch_scalar",
    "fetch_many",
    "execute",
];

/// Bare-pool executor expressions (no armed transaction). `tx.as_mut()`,
/// `&mut *tx`, `conn`, `executor`, etc. are NOT bare pools and are allowed.
const BARE_POOL_ARGS: &[&str] = &["&self.pool", "self.pool()", "&pool", "pool", "&self.pool()"];

const ALLOW_MARKER: &str = "rls-arming: ok";

pub fn check_workspace(workspace_dir: &Path) -> Result<GateResult, String> {
    let files = collect_scanned_files(workspace_dir)?;
    let mut result = GateResult::default();
    for file in files {
        let content = fs::read_to_string(&file)
            .map_err(|e| format!("cannot read {}: {e}", file.display()))?;
        scan_file(&file, &content, &mut result);
    }
    Ok(result)
}

fn scan_file(file: &Path, content: &str, result: &mut GateResult) {
    // Skip test code: `#[sqlx::test]` harnesses legitimately connect as the
    // BYPASSRLS owner. We only police production data-layer code.
    let lines: Vec<&str> = content.lines().collect();
    let in_test = compute_test_mask(&lines);

    for (idx, raw) in lines.iter().enumerate() {
        if in_test[idx] {
            continue;
        }
        let line = strip_line_comment(raw);
        let Some(method) = EXEC_METHODS
            .iter()
            .find(|m| line.contains(&format!(".{m}(")))
        else {
            continue;
        };
        // Extract the executor argument immediately after `.<method>(`, allowing
        // it to spill onto following lines (sqlx fluent chains).
        let Some(arg) = executor_arg(&lines, idx, method) else {
            continue;
        };
        if !BARE_POOL_ARGS.contains(&arg.as_str()) {
            continue;
        }
        // Allow if this line or the preceding line carries the review marker.
        if raw.contains(ALLOW_MARKER)
            || (idx > 0 && lines[idx - 1].contains(ALLOW_MARKER))
            || (idx + 1 < lines.len() && lines[idx + 1].contains(ALLOW_MARKER))
        {
            continue;
        }
        result.violations.push(Violation {
            file: file.to_path_buf(),
            line: idx + 1,
            detail: format!(
                ".{method}({arg}) executes on a bare pool with no armed app.current_org \
                 GUC — wrap the read in with_org_conn(self.pool(), current_org()?, ..) / \
                 with_audit(s), or add `// rls-arming: ok <reason>` if the table is global/non-RLS"
            ),
        });
    }
}

/// Returns the executor argument string for a `.<method>(` occurrence starting at
/// `start_idx`, joining up to a few following lines so a multi-line call like
/// `.fetch_optional(\n    &self.pool,\n)` is handled. Normalizes whitespace.
fn executor_arg(lines: &[&str], start_idx: usize, method: &str) -> Option<String> {
    let needle = format!(".{method}(");
    // Join this line + the next 2 to capture spilled args, from the needle on.
    let mut joined = String::new();
    for line in lines.iter().skip(start_idx).take(3) {
        joined.push_str(strip_line_comment(line));
        joined.push(' ');
    }
    let pos = joined.find(&needle)? + needle.len();
    let rest = &joined[pos..];
    // The arg is everything up to the matching close paren (first `)` at depth 0)
    // or a comma at depth 0.
    let mut depth = 0i32;
    let mut arg = String::new();
    for ch in rest.chars() {
        match ch {
            '(' => {
                depth += 1;
                arg.push(ch);
            }
            ')' => {
                if depth == 0 {
                    break;
                }
                depth -= 1;
                arg.push(ch);
            }
            ',' if depth == 0 => break,
            _ => arg.push(ch),
        }
    }
    let normalized = arg.split_whitespace().collect::<String>();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

/// Marks lines inside `#[cfg(test)]` modules / `#[sqlx::test]` items as test code.
/// Heuristic but conservative: once a `#[cfg(test)]` mod opens we track brace
/// depth back to its start.
fn compute_test_mask(lines: &[&str]) -> Vec<bool> {
    let mut mask = vec![false; lines.len()];
    let mut i = 0;
    while i < lines.len() {
        let l = lines[i].trim_start();
        if l.starts_with("#[cfg(test)]") {
            // find the `mod ... {` that follows and mask to its closing brace
            let mut j = i;
            while j < lines.len() && !lines[j].contains('{') {
                j += 1;
            }
            if j < lines.len() {
                let mut depth = 0i32;
                let mut k = j;
                loop {
                    if k >= lines.len() {
                        break;
                    }
                    for ch in lines[k].chars() {
                        if ch == '{' {
                            depth += 1;
                        } else if ch == '}' {
                            depth -= 1;
                        }
                    }
                    mask[k] = true;
                    if depth <= 0 {
                        break;
                    }
                    k += 1;
                }
                i = k + 1;
                continue;
            }
        }
        i += 1;
    }
    mask
}

fn strip_line_comment(line: &str) -> &str {
    match line.find("//") {
        Some(pos) => &line[..pos],
        None => line,
    }
}

/// Collect production data-layer source files: every `*/adapter-postgres/src` and
/// `*/rest/src`, plus the platform crates that own pools (realtime, storage,
/// authz, auth, provisioning, auth-rest). Excludes the db crate (it DEFINES
/// with_org_conn / with_audit and the audit_tx pool plumbing), the gate crates,
/// tests/ dirs, and target/.
fn collect_scanned_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let crates_dir = root.join("crates");
    let mut files = Vec::new();
    let mut seen: BTreeSet<PathBuf> = BTreeSet::new();
    walk_rs(&crates_dir, &mut files, &mut seen)?;
    files.sort();
    Ok(files)
}

fn walk_rs(
    dir: &Path,
    files: &mut Vec<PathBuf>,
    seen: &mut BTreeSet<PathBuf>,
) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| format!("entry in {}: {e}", dir.display()))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let ft = entry.file_type().map_err(|e| format!("file_type: {e}"))?;
        if ft.is_dir() {
            // Skip non-source dirs.
            if name == "target" || name == "tests" || name == "benches" || name == ".git" {
                continue;
            }
            walk_rs(&path, files, seen)?;
        } else if ft.is_file()
            && path.extension().is_some_and(|e| e == "rs")
            && is_scanned_path(&path)
            && seen.insert(path.clone())
        {
            files.push(path);
        }
    }
    Ok(())
}

/// Only police production data-layer code: adapter-postgres/src, rest/src, and the
/// pool-holding platform crates. Exclude the db crate (defines the arming
/// primitives + audit_tx), the gate crates, and migration runner.
fn is_scanned_path(path: &Path) -> bool {
    let s = path.to_string_lossy().replace('\\', "/");
    if !s.contains("/src/") {
        return false;
    }
    // Exclusions: the db crate owns with_org_conn/with_audit; ci gates; the app
    // crate's migrate runner is fine (no tenant reads on bare pool there).
    if s.contains("/platform/db/") || s.contains("/ci/gates/") {
        return false;
    }
    s.contains("/adapter-postgres/src/")
        || s.contains("/rest/src/")
        || s.contains("/platform/realtime/src/")
        || s.contains("/platform/storage/src/")
        || s.contains("/platform/authz/src/")
        || s.contains("/platform/auth/src/")
        || s.contains("/platform/auth-rest/src/")
        || s.contains("/platform/provisioning/src/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(src: &str) -> GateResult {
        let mut r = GateResult::default();
        scan_file(
            Path::new("crates/x/adapter-postgres/src/lib.rs"),
            src,
            &mut r,
        );
        r
    }

    #[test]
    fn flags_bare_self_pool_fetch() {
        let r = scan("let x = sqlx::query(\"SELECT 1\").fetch_optional(&self.pool).await?;");
        assert_eq!(r.violations.len(), 1);
    }

    #[test]
    fn allows_tx_executor() {
        let r = scan("let x = sqlx::query(\"SELECT 1\").fetch_optional(tx.as_mut()).await?;");
        assert!(r.passed());
    }

    #[test]
    fn allows_marked_global_read() {
        let r = scan(
            "// rls-arming: ok auth_rate_limit is global, no RLS\n\
             let x = sqlx::query(\"...\").fetch_one(&self.pool).await?;",
        );
        assert!(r.passed());
    }

    #[test]
    fn flags_self_pool_accessor() {
        let r = scan("sqlx::query(\"..\").execute(self.pool()).await?;");
        assert_eq!(r.violations.len(), 1);
    }

    #[test]
    fn handles_multiline_arg() {
        let r = scan(
            "sqlx::query(\"..\")\n        .fetch_all(\n            &self.pool,\n        )\n        .await?;",
        );
        assert_eq!(r.violations.len(), 1);
    }

    #[test]
    fn ignores_test_modules() {
        let r = scan(
            "#[cfg(test)]\nmod tests {\n    fn t() { sqlx::query(\"..\").fetch_one(&self.pool); }\n}",
        );
        assert!(r.passed());
    }
}
