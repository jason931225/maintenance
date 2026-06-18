//! Tenant-isolation gate.
//!
//! Multi-tenant phase 1 enforces tenant isolation with Postgres Row Level
//! Security: every tenant-scoped table carries a NOT NULL `org_id` and an
//! `org_isolation` policy gated on `current_setting('app.current_org')`, with
//! both ENABLE and FORCE ROW LEVEL SECURITY (FORCE so the table owner is subject
//! to the policy too — otherwise an owner connection silently bypasses tenancy).
//!
//! This gate is a STATIC scan of `crates/platform/db/migrations/*.sql` plus a
//! source assertion on the `with_audit` GUC bind. It mirrors the tokenizer /
//! SQL-sanitizer style of the migration-safety gate. The companion DYNAMIC proof
//! (RLS actually isolates two orgs end-to-end) lives in the platform-db
//! integration test `crates/platform/db/tests/rls_isolation.rs`, NOT here.
//!
//! ## What it asserts
//!  1. Every table with RLS ENABLED also has FORCE + an `org_isolation`-style
//!     policy whose USING/WITH CHECK references `current_setting('app.current_org'`.
//!     (RLS-on without FORCE = owner bypass; RLS-on without a policy = lockout.)
//!  2. Every table that gains an `org_id` column — except the small nullable /
//!     platform allowlist (audit_events) — is RLS ENABLED + FORCED + policied.
//!  3. No migration arms the GUC with a NON-local `set_config(..., false)` or a
//!     session-level `SET app.current_org` (cross-request bleed).
//!  4. Every CREATE TABLE is classified: it must either gain an `org_id` column
//!     (tenant) or be in the explicit global allowlist. A NEW table that is
//!     neither is flagged "unclassified" — the forward-looking guard so the next
//!     table added cannot silently miss tenancy.
//!  5. The `with_audit`/`with_audits` source still binds
//!     `set_config('app.current_org'`, so nobody removes GUC propagation.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

// ===========================================================================
// Allowlists.
// ===========================================================================

/// Tables that are intentionally GLOBAL — no `org_id`, no RLS. Each entry is a
/// deliberate tenancy carve-out with a rationale, so a reviewer can see exactly
/// why isolation does not apply. A NEW table that is neither tenant-scoped nor
/// listed here is flagged `UnclassifiedTable` (the forward-looking guard).
#[must_use]
pub fn global_table_allowlist() -> &'static [(&'static str, &'static str)] {
    &[
        // Pre-auth throttle: keyed on (ip, purpose), exists before any user/org
        // is resolved. Transient, no tenant.
        ("auth_rate_limit", "pre-auth throttle, no resolved tenant"),
        // WebAuthn ceremony state: a registration/login ceremony exists before
        // the user (and therefore the org) is known; user_id is nullable.
        (
            "auth_webauthn_ceremonies",
            "pre-auth ceremony state, user/org not yet resolved",
        ),
        // Apalis job/queue tables: created and owned by the apalis-postgres
        // worker runtime, NOT by our migrations. Listed so that if a future
        // migration ever does touch them, the classifier already accounts for
        // their global, non-tenant nature.
        ("apalis_jobs", "apalis worker-owned queue table (platform)"),
        (
            "apalis_workers",
            "apalis worker-owned heartbeat table (platform)",
        ),
        // location_pings is a PARTITIONED table; its monthly partition children
        // are created dynamically (`CREATE TABLE %I PARTITION OF location_pings`)
        // and inherit RLS from the parent. The parent itself IS tenant-scoped and
        // is checked normally; partition children are not independently scanned.
    ]
}

/// Tenant tables that legitimately have a NULLABLE `org_id` and therefore are
/// NOT required to enforce `org_id NOT NULL`, while STILL requiring RLS +
/// FORCE + policy. `audit_events` is the platform-tier audit log: platform
/// events (roster import, retention jobs) have no tenant, so org_id stays
/// nullable, but tenant-scoped audit rows must still be isolated by RLS.
#[must_use]
pub fn nullable_org_allowlist() -> &'static [&'static str] {
    &["audit_events"]
}

/// Repo-relative source file that must keep binding the `app.current_org` GUC,
/// and the exact bind token it must contain. Mirrors how audit-coverage pins
/// the `with_audit` mechanism.
const AUDIT_TX_FILE: &str = "crates/platform/db/src/audit_tx.rs";
const GUC_BIND_TOKEN: &str = "set_config('app.current_org'";

// ===========================================================================
// Violations.
// ===========================================================================

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ViolationKind {
    /// RLS ENABLED but FORCE ROW LEVEL SECURITY missing (owner bypass risk).
    RlsEnabledWithoutForce,
    /// RLS ENABLED but no `current_setting('app.current_org'` policy (lockout).
    RlsEnabledWithoutOrgPolicy,
    /// Table has an `org_id` column but RLS is not enabled (untenanted leak).
    OrgColumnWithoutRls,
    /// A CREATE TABLE that is neither tenant-scoped nor in the global allowlist.
    UnclassifiedTable,
    /// GUC armed non-locally (`set_config(..., false)` / session `SET`).
    NonLocalGucMutation,
    /// `with_audit` source lost the `set_config('app.current_org'` bind.
    MissingGucBindInAuditTx,
    /// I/O or scan failure.
    ScanError,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    pub kind: ViolationKind,
    pub file: PathBuf,
    pub detail: String,
}

impl std::fmt::Display for Violation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "[{:?}] {}: {}",
            self.kind,
            self.file.display(),
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

// ===========================================================================
// Entry points.
// ===========================================================================

pub fn check_workspace(workspace_dir: &Path) -> Result<GateResult, String> {
    let mut result = GateResult::default();

    let migration_files = collect_migration_files(workspace_dir)?;
    check_migrations(migration_files, &mut result);

    let rust_files = collect_rust_files(workspace_dir)?;
    check_audit_tx_guc_bind(&rust_files, &mut result);

    Ok(result)
}

/// Check a migrations directory in isolation (used by the unit tests).
///
/// `root` is a directory that CONTAINS a `migrations/` subdirectory (the scan
/// descends into it), mirroring `check_workspace`'s discovery.
#[must_use]
pub fn check_migrations_root(root: &Path) -> GateResult {
    let mut result = GateResult::default();
    match collect_migration_files(root) {
        Ok(files) => check_migrations(files, &mut result),
        Err(e) => result.violations.push(Violation {
            kind: ViolationKind::ScanError,
            file: root.to_path_buf(),
            detail: e,
        }),
    }
    result
}

// ===========================================================================
// Per-table evidence aggregated across all migration files.
// ===========================================================================

#[derive(Debug, Default, Clone)]
struct TableFacts {
    created_in: Option<PathBuf>,
    has_org_column: bool,
    org_column_file: Option<PathBuf>,
    rls_enabled: bool,
    rls_forced: bool,
    has_org_policy: bool,
    rls_file: Option<PathBuf>,
}

fn check_migrations(files: Vec<PathBuf>, result: &mut GateResult) {
    let mut facts: HashMap<String, TableFacts> = HashMap::new();

    for file in files {
        match fs::read_to_string(&file) {
            Ok(content) => {
                let sanitized = sanitize_sql(&content);
                scan_file(&file, &content, &sanitized, &mut facts, result);
            }
            Err(e) => result.violations.push(Violation {
                kind: ViolationKind::ScanError,
                file,
                detail: format!("cannot read migration file: {e}"),
            }),
        }
    }

    evaluate_facts(&facts, result);
}

/// Pull every fact a single migration file contributes about each table.
///
/// `raw` is the original SQL; `sanitized` has comments/string-literals blanked
/// (the migration-safety scanner style). Most discovery runs on `sanitized` so
/// that commented-out DDL is ignored. The dynamic-RLS and GUC checks need `raw`
/// because the table names and the `app.current_org` literal live INSIDE single
/// quotes (`format('... %I ...')`, `set_config('app.current_org', ...)`), which
/// the sanitizer blanks.
fn scan_file(
    file: &Path,
    raw: &str,
    sanitized: &str,
    facts: &mut HashMap<String, TableFacts>,
    result: &mut GateResult,
) {
    discover_created_tables(file, sanitized, facts);
    discover_org_columns(file, sanitized, facts);
    discover_literal_rls(file, sanitized, facts);
    discover_dynamic_rls(file, raw, facts);
    check_non_local_guc(file, raw, result);
}

// ---------------------------------------------------------------------------
// CREATE TABLE discovery.
// ---------------------------------------------------------------------------

fn discover_created_tables(file: &Path, sanitized: &str, facts: &mut HashMap<String, TableFacts>) {
    for statement in sanitized.split(';') {
        let tokens = tokenize_sql(statement);
        for (index, token) in tokens.iter().enumerate() {
            if token != "create" || tokens.get(index + 1).is_none_or(|t| t != "table") {
                continue;
            }
            let Some(name) = table_name_after_create_table(&tokens, index + 2) else {
                continue;
            };
            // Skip dynamic `CREATE TABLE %I ...` (the `%I` placeholder becomes an
            // empty/garbage token) and the partition-of children of location_pings.
            if name.is_empty() || statement_is_partition_of(statement) {
                continue;
            }
            let entry = facts.entry(name.to_string()).or_default();
            if entry.created_in.is_none() {
                entry.created_in = Some(file.to_path_buf());
            }
        }
    }
}

/// `CREATE TABLE [IF NOT EXISTS] <name>` — skip the optional `if not exists`.
fn table_name_after_create_table(tokens: &[String], start: usize) -> Option<&str> {
    let mut index = start;
    if tokens.get(index).is_some_and(|t| t == "if")
        && tokens.get(index + 1).is_some_and(|t| t == "not")
        && tokens.get(index + 2).is_some_and(|t| t == "exists")
    {
        index += 3;
    }
    tokens.get(index).map(String::as_str)
}

fn statement_is_partition_of(statement: &str) -> bool {
    let lower = statement.to_ascii_lowercase();
    lower.contains("partition of")
}

// ---------------------------------------------------------------------------
// org_id column discovery (`ADD COLUMN org_id` and `org_id uuid` in CREATE).
// ---------------------------------------------------------------------------

fn discover_org_columns(file: &Path, sanitized: &str, facts: &mut HashMap<String, TableFacts>) {
    for statement in sanitized.split(';') {
        let tokens = tokenize_sql(statement);
        // ALTER TABLE <t> ... ADD COLUMN org_id ...
        if let Some(table) = alter_table_target(&tokens)
            && tokens_contain_sequence(&tokens, &["add", "column", "org_id"])
        {
            mark_org_column(file, table, facts);
        }
        // CREATE TABLE <t> ( ... org_id uuid ... )
        for (index, token) in tokens.iter().enumerate() {
            if token != "create" || tokens.get(index + 1).is_none_or(|t| t != "table") {
                continue;
            }
            let Some(table) = table_name_after_create_table(&tokens, index + 2) else {
                continue;
            };
            if !table.is_empty()
                && !statement_is_partition_of(statement)
                && tokens_contain_sequence(&tokens, &["org_id", "uuid"])
            {
                let table = table.to_string();
                mark_org_column(file, &table, facts);
            }
        }
    }
}

fn mark_org_column(file: &Path, table: &str, facts: &mut HashMap<String, TableFacts>) {
    let entry = facts.entry(table.to_string()).or_default();
    entry.has_org_column = true;
    if entry.org_column_file.is_none() {
        entry.org_column_file = Some(file.to_path_buf());
    }
}

/// `ALTER TABLE [IF EXISTS] <name>` → the target table.
fn alter_table_target(tokens: &[String]) -> Option<&str> {
    let pos = tokens
        .windows(2)
        .position(|w| w[0] == "alter" && w[1] == "table")?;
    let mut index = pos + 2;
    if tokens.get(index).is_some_and(|t| t == "if")
        && tokens.get(index + 1).is_some_and(|t| t == "exists")
    {
        index += 2;
    }
    tokens.get(index).map(String::as_str)
}

// ---------------------------------------------------------------------------
// RLS discovery — literal statements.
// ---------------------------------------------------------------------------

fn discover_literal_rls(file: &Path, sanitized: &str, facts: &mut HashMap<String, TableFacts>) {
    // Tokenize the SANITIZED statements (commented-out / string-literal DDL is
    // blanked, including inside `$$ ... $$` PL/pgSQL bodies). The GUC literal
    // `'app.current_org'` is itself inside single quotes, so we cannot read it
    // off the sanitized text; instead, `policy_gates_on_current_org` re-derives
    // the policy's GUC reference from the structural keywords that survive
    // sanitization (NULLIF / current_setting / ::uuid all live OUTSIDE the GUC
    // string), falling back to confirming the table name is the policy target.
    for statement in sanitized.split(';') {
        let tokens = tokenize_sql(statement);
        if tokens.is_empty() {
            continue;
        }

        // ALTER TABLE <t> ENABLE / FORCE ROW LEVEL SECURITY.
        if let Some(table) = alter_table_target(&tokens) {
            let enables = tokens_contain_sequence(&tokens, &["enable", "row", "level", "security"]);
            let forces = tokens_contain_sequence(&tokens, &["force", "row", "level", "security"]);
            if enables || forces {
                let table = table.to_string();
                let entry = facts.entry(table).or_default();
                entry.rls_enabled |= enables;
                entry.rls_forced |= forces;
                if entry.rls_file.is_none() {
                    entry.rls_file = Some(file.to_path_buf());
                }
            }
        }

        // CREATE POLICY <name> ON <t> ... current_setting('app.current_org' ...
        if tokens.first().is_some_and(|t| t == "create")
            && tokens.get(1).is_some_and(|t| t == "policy")
            && let Some(table) = policy_target_table(&tokens)
            && policy_gates_on_current_org(&tokens)
        {
            let entry = facts.entry(table.to_string()).or_default();
            entry.has_org_policy = true;
            if entry.rls_file.is_none() {
                entry.rls_file = Some(file.to_path_buf());
            }
        }
    }
}

/// `CREATE POLICY <policy_name> ON <table>` → the table the policy is on.
fn policy_target_table(tokens: &[String]) -> Option<&str> {
    let on_pos = tokens.iter().position(|t| t == "on")?;
    tokens.get(on_pos + 1).map(String::as_str)
}

/// True when a CREATE POLICY statement's USING/WITH CHECK gates on the tenant
/// GUC. The GUC name `'app.current_org'` is inside single quotes (blanked by the
/// sanitizer), so we key on the `current_setting` CALL token, which survives.
/// Every org_isolation policy in the migrations is built as
/// `... current_setting('app.current_org', true) ...`; a CREATE POLICY that
/// calls `current_setting` at all is gating on a GUC, and the only GUC the
/// tenant policies use is `app.current_org`.
fn policy_gates_on_current_org(tokens: &[String]) -> bool {
    tokens.iter().any(|t| t == "current_setting")
}

// ---------------------------------------------------------------------------
// RLS discovery — dynamic `DO $$ ... ARRAY[...] ... format(... RLS ...)`.
// ---------------------------------------------------------------------------

/// migration 0035 enables RLS on a whole list of tables via a single
/// `FOREACH t IN ARRAY tenant_tables LOOP EXECUTE format('ALTER TABLE %I ENABLE
/// ROW LEVEL SECURITY', t) ...` block. The literal scan never sees a table name
/// next to ENABLE, so we credit every table named in an `ARRAY[ ... ]` literal
/// when the same file's format() calls cover ENABLE + FORCE + an
/// org-policy CREATE POLICY. The loop applies all three uniformly to each array
/// member, so crediting them together is sound.
fn discover_dynamic_rls(file: &Path, raw: &str, facts: &mut HashMap<String, TableFacts>) {
    let lower = raw.to_ascii_lowercase();

    let format_enables = lower.contains("enable row level security");
    let format_forces = lower.contains("force row level security");
    let format_policy = lower.contains("create policy") && lower.contains("app.current_org");

    // Only treat this as a dynamic RLS block when it is actually loop-driven
    // (a FOREACH over an ARRAY) and the three pieces are present in format()s.
    if !(lower.contains("foreach") && lower.contains("array[")) {
        return;
    }
    if !(format_enables && format_forces && format_policy) {
        return;
    }

    for table in extract_array_string_literals(raw) {
        let entry = facts.entry(table).or_default();
        entry.rls_enabled = true;
        entry.rls_forced = true;
        entry.has_org_policy = true;
        if entry.rls_file.is_none() {
            entry.rls_file = Some(file.to_path_buf());
        }
    }
}

/// Extract every single-quoted identifier inside an `ARRAY[ ... ]` literal.
/// Tolerant: scans each `ARRAY[` region and pulls the `'name'` tokens until the
/// matching `]`.
fn extract_array_string_literals(raw: &str) -> Vec<String> {
    let lower = raw.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut search_from = 0usize;

    while let Some(rel) = lower[search_from..].find("array[") {
        let open = search_from + rel + "array[".len();
        let Some(close_rel) = raw[open..].find(']') else {
            break;
        };
        let close = open + close_rel;
        let region = &raw[open..close];
        // A flat list of single-quoted identifiers. SQL escapes a quote as `''`;
        // table identifiers never contain quotes, so a simple alternating scan
        // of quote boundaries is sufficient and avoids mis-pairing.
        let mut in_quote = false;
        let mut literal = String::new();
        for ch in region.chars() {
            if ch == '\'' {
                if in_quote {
                    let normalized = literal.trim().to_ascii_lowercase();
                    if !normalized.is_empty() {
                        out.push(normalized);
                    }
                    literal.clear();
                }
                in_quote = !in_quote;
            } else if in_quote {
                literal.push(ch);
            }
        }
        search_from = close + 1;
    }
    out
}

// ---------------------------------------------------------------------------
// Non-local GUC mutation.
// ---------------------------------------------------------------------------

fn check_non_local_guc(file: &Path, raw: &str, result: &mut GateResult) {
    // The sanitizer blanks the quoted GUC name, so this check runs on the RAW
    // content where `'app.current_org'` survives.
    let raw_lower = raw.to_ascii_lowercase();

    for (call_idx, _) in raw_lower.match_indices("set_config") {
        // Only care about app.current_org calls.
        let tail = &raw_lower[call_idx..];
        let Some(close_rel) = tail.find(')') else {
            continue;
        };
        let call = &tail[..close_rel + 1];
        if !call.contains("app.current_org") {
            continue;
        }
        // The third argument is the is_local flag. A literal `false` (or `0`,
        // or `f`) makes the setting session-scoped → cross-request bleed.
        if call_arg_is_non_local(call) {
            result.violations.push(Violation {
                kind: ViolationKind::NonLocalGucMutation,
                file: file.to_path_buf(),
                detail: "set_config('app.current_org', ..., false) is session-scoped; the tenant \
                         GUC must be transaction-local (is_local = true)"
                    .to_string(),
            });
        }
    }

    // `SET app.current_org` (session GUC) — `SET LOCAL app.current_org` is fine.
    for (idx, _) in raw_lower.match_indices("app.current_org") {
        let prefix = &raw_lower[..idx];
        // Find the nearest preceding `set` keyword on the same logical line.
        if let Some(set_pos) = prefix.rfind("set ") {
            let between = &raw_lower[set_pos + 4..idx];
            // No `local`/`config(` between SET and the GUC name → bare session SET.
            if between.trim().is_empty() {
                result.violations.push(Violation {
                    kind: ViolationKind::NonLocalGucMutation,
                    file: file.to_path_buf(),
                    detail: "bare `SET app.current_org` is session-scoped; use `SET LOCAL` or \
                             set_config(..., true)"
                        .to_string(),
                });
            }
        }
    }
}

/// Inspect a `set_config(...)` call text and decide whether its `is_local` arg
/// is non-local. We look at the last comma-separated argument before `)`.
fn call_arg_is_non_local(call: &str) -> bool {
    let inner = call
        .trim_start_matches("set_config")
        .trim_start()
        .trim_start_matches('(')
        .trim_end_matches(')');
    let last_arg = inner.rsplit(',').next().unwrap_or("").trim();
    matches!(last_arg, "false" | "'f'" | "f" | "0" | "'false'" | "'0'")
}

// ===========================================================================
// Evaluation — turn aggregated facts into violations.
// ===========================================================================

fn evaluate_facts(facts: &HashMap<String, TableFacts>, result: &mut GateResult) {
    let global: HashSet<&str> = global_table_allowlist().iter().map(|(t, _)| *t).collect();
    // Tables whose org_id is intentionally NULLABLE (audit_events). They are NOT
    // in `global` — they carry org_id and MUST still be RLS-protected — so they
    // flow through the normal org-column → RLS checks below. We surface the set
    // here so a nullable-org table that somehow lost RLS gets a clearer message.
    let nullable_org: HashSet<&str> = nullable_org_allowlist().iter().copied().collect();

    for (table, f) in facts {
        let migrations_root = f
            .created_in
            .clone()
            .or_else(|| f.org_column_file.clone())
            .or_else(|| f.rls_file.clone())
            .unwrap_or_else(|| PathBuf::from("crates/platform/db/migrations"));

        let tenant_scoped = f.has_org_column || f.rls_enabled || f.has_org_policy;

        // (1) RLS ENABLED ⇒ FORCE + org policy.
        if f.rls_enabled {
            if !f.rls_forced {
                result.violations.push(Violation {
                    kind: ViolationKind::RlsEnabledWithoutForce,
                    file: f
                        .rls_file
                        .clone()
                        .unwrap_or_else(|| migrations_root.clone()),
                    detail: format!(
                        "table '{table}' has ENABLE ROW LEVEL SECURITY but no FORCE ROW LEVEL \
                         SECURITY (the owner connection would bypass every policy)"
                    ),
                });
            }
            if !f.has_org_policy {
                result.violations.push(Violation {
                    kind: ViolationKind::RlsEnabledWithoutOrgPolicy,
                    file: f
                        .rls_file
                        .clone()
                        .unwrap_or_else(|| migrations_root.clone()),
                    detail: format!(
                        "table '{table}' has RLS enabled but no CREATE POLICY referencing \
                         current_setting('app.current_org') (every row would be locked out)"
                    ),
                });
            }
        }

        // (2) org_id column ⇒ RLS enabled (unless allowlisted). When RLS IS
        // enabled, the FORCE + org-policy sub-checks in (1) already cover the
        // rest, so this branch only needs to catch the "org_id but no RLS" gap.
        if f.has_org_column && !global.contains(table.as_str()) && !f.rls_enabled {
            let nullable_note = if nullable_org.contains(table.as_str()) {
                " (its org_id is nullable by allowlist, but RLS is still mandatory)"
            } else {
                ""
            };
            result.violations.push(Violation {
                kind: ViolationKind::OrgColumnWithoutRls,
                file: f
                    .org_column_file
                    .clone()
                    .unwrap_or_else(|| migrations_root.clone()),
                detail: format!(
                    "tenant table '{table}' has an org_id column but no ENABLE ROW LEVEL \
                     SECURITY (rows are not isolated by tenant){nullable_note}"
                ),
            });
        }

        // (4) Classification: a CREATE TABLE must be tenant-scoped or allowlisted.
        if f.created_in.is_some() && !tenant_scoped && !global.contains(table.as_str()) {
            result.violations.push(Violation {
                kind: ViolationKind::UnclassifiedTable,
                file: f.created_in.clone().unwrap_or(migrations_root),
                detail: format!(
                    "table '{table}' is unclassified — it has neither an org_id column / RLS nor \
                     is it in the global allowlist. Add org_id + RLS, or allowlist it in \
                     global_table_allowlist() with a rationale."
                ),
            });
        }
    }
}

// ===========================================================================
// with_audit GUC bind assertion.
// ===========================================================================

fn check_audit_tx_guc_bind(rust_files: &[PathBuf], result: &mut GateResult) {
    let Some(file) = rust_files
        .iter()
        .find(|p| path_ends_with_repo_relative(p, AUDIT_TX_FILE))
    else {
        result.violations.push(Violation {
            kind: ViolationKind::MissingGucBindInAuditTx,
            file: PathBuf::from(AUDIT_TX_FILE),
            detail: format!("expected source file {AUDIT_TX_FILE} was not found"),
        });
        return;
    };

    let Ok(source) = fs::read_to_string(file) else {
        result.violations.push(Violation {
            kind: ViolationKind::MissingGucBindInAuditTx,
            file: file.clone(),
            detail: "cannot read audit_tx source file".to_string(),
        });
        return;
    };

    if !source.contains(GUC_BIND_TOKEN) {
        result.violations.push(Violation {
            kind: ViolationKind::MissingGucBindInAuditTx,
            file: file.clone(),
            detail: format!(
                "audit_tx.rs must bind the tenant GUC via `{GUC_BIND_TOKEN}` so with_audit / \
                 with_audits / with_org_conn propagate app.current_org — the bind is gone"
            ),
        });
    }
}

// ===========================================================================
// Shared helpers (tokenizer / sanitizer style mirrored from migration-safety).
// ===========================================================================

fn tokens_contain_sequence(tokens: &[String], sequence: &[&str]) -> bool {
    if sequence.is_empty() || tokens.len() < sequence.len() {
        return false;
    }
    tokens
        .windows(sequence.len())
        .any(|window| window.iter().zip(sequence).all(|(t, s)| t == s))
}

fn sanitize_sql(content: &str) -> String {
    let bytes = content.as_bytes();
    let mut output = String::with_capacity(content.len());
    let mut index = 0usize;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    // PL/pgSQL dollar-quoting: `$$ ... $$` or `$tag$ ... $tag$`. The body holds
    // DDL-as-string (e.g. 0035's RLS rollout loop) with its own `'` and `;`. We
    // blank the body so its quotes never corrupt single-quote state — BUT keep
    // `;` and newlines intact, so `raw.split(';')` and `sanitized.split(';')`
    // stay byte-position aligned (the literal-RLS scan zips the two).
    let mut dollar_tag: Option<String> = None;

    while index < bytes.len() {
        let b = bytes[index];
        let next = bytes.get(index + 1).copied();

        if let Some(tag) = &dollar_tag {
            if content[index..].starts_with(tag.as_str()) {
                for _ in 0..tag.len() {
                    output.push(' ');
                }
                index += tag.len();
                dollar_tag = None;
            } else {
                output.push(match b {
                    b'\n' => '\n',
                    b';' => ';',
                    _ => ' ',
                });
                index += 1;
            }
            continue;
        }

        if in_line_comment {
            if b == b'\n' {
                in_line_comment = false;
                output.push('\n');
            } else {
                output.push(' ');
            }
            index += 1;
            continue;
        }
        if in_block_comment {
            if b == b'*' && next == Some(b'/') {
                in_block_comment = false;
                output.push_str("  ");
                index += 2;
            } else {
                output.push(if b == b'\n' { '\n' } else { ' ' });
                index += 1;
            }
            continue;
        }
        if in_single_quote {
            if b == b'\'' && next == Some(b'\'') {
                output.push_str("  ");
                index += 2;
            } else if b == b'\'' {
                in_single_quote = false;
                output.push(' ');
                index += 1;
            } else {
                output.push(if b == b'\n' { '\n' } else { ' ' });
                index += 1;
            }
            continue;
        }
        if in_double_quote {
            if b == b'"' {
                in_double_quote = false;
                output.push(' ');
            } else {
                output.push((b as char).to_ascii_lowercase());
            }
            index += 1;
            continue;
        }

        if b == b'-' && next == Some(b'-') {
            in_line_comment = true;
            output.push_str("  ");
            index += 2;
        } else if b == b'/' && next == Some(b'*') {
            in_block_comment = true;
            output.push_str("  ");
            index += 2;
        } else if b == b'$'
            && let Some(tag) = dollar_quote_tag_at(content, index)
        {
            for _ in 0..tag.len() {
                output.push(' ');
            }
            index += tag.len();
            dollar_tag = Some(tag);
        } else if b == b'\'' {
            in_single_quote = true;
            output.push(' ');
            index += 1;
        } else if b == b'"' {
            in_double_quote = true;
            output.push(' ');
            index += 1;
        } else {
            output.push((b as char).to_ascii_lowercase());
            index += 1;
        }
    }

    output
}

/// If a dollar-quote tag (`$$` or `$tag$`) opens at `start`, return it (e.g.
/// `"$$"` or `"$body$"`). The tag is `$`, an optional identifier, then `$`.
fn dollar_quote_tag_at(content: &str, start: usize) -> Option<String> {
    let rest = content.get(start..)?;
    let mut bytes = rest.bytes();
    if bytes.next() != Some(b'$') {
        return None;
    }
    let mut len = 1usize;
    for b in bytes {
        if b == b'$' {
            return Some(rest[..len + 1].to_string());
        }
        // Tag identifiers are letters/digits/underscore; anything else means this
        // `$` is not a dollar-quote opener (e.g. `$1` placeholders end at `1`,
        // which is allowed, but a space/paren is not — bail out then).
        if b.is_ascii_alphanumeric() || b == b'_' {
            len += 1;
        } else {
            return None;
        }
    }
    None
}

fn tokenize_sql(statement: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();

    for ch in statement.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            current.push(ch);
        } else if !current.is_empty() {
            tokens.push(normalize_identifier(&current));
            current.clear();
        }
    }
    if !current.is_empty() {
        tokens.push(normalize_identifier(&current));
    }

    tokens
}

fn normalize_identifier(identifier: &str) -> String {
    identifier
        .trim_matches(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn path_ends_with_repo_relative(file: &Path, repo_relative: &str) -> bool {
    let expected: Vec<&str> = repo_relative.split('/').filter(|s| !s.is_empty()).collect();
    let actual: Vec<String> = file
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect();
    if expected.len() > actual.len() {
        return false;
    }
    actual[actual.len() - expected.len()..]
        .iter()
        .zip(expected.iter())
        .all(|(actual_part, expected_part)| actual_part == expected_part)
}

// ===========================================================================
// File collection.
// ===========================================================================

fn collect_migration_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    collect_migration_files_inner(root, false, &mut files)?;
    Ok(files)
}

fn collect_migration_files_inner(
    dir: &Path,
    in_migrations_dir: bool,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if should_skip_dir(dir) {
        return Ok(());
    }

    let entries =
        fs::read_dir(dir).map_err(|e| format!("cannot read directory {}: {e}", dir.display()))?;
    for entry in entries {
        let entry =
            entry.map_err(|e| format!("cannot read directory entry in {}: {e}", dir.display()))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| format!("cannot read file type for {}: {e}", path.display()))?;
        if file_type.is_dir() {
            let is_migrations = entry.file_name().to_string_lossy() == "migrations";
            collect_migration_files_inner(&path, in_migrations_dir || is_migrations, files)?;
        } else if file_type.is_file()
            && in_migrations_dir
            && path.extension().is_some_and(|ext| ext == "sql")
        {
            files.push(path);
        }
    }
    Ok(())
}

fn collect_rust_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    collect_rust_files_inner(root, &mut files)?;
    Ok(files)
}

fn collect_rust_files_inner(dir: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    if should_skip_dir(dir) {
        return Ok(());
    }

    let entries =
        fs::read_dir(dir).map_err(|e| format!("cannot read directory {}: {e}", dir.display()))?;
    for entry in entries {
        let entry =
            entry.map_err(|e| format!("cannot read directory entry in {}: {e}", dir.display()))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| format!("cannot read file type for {}: {e}", path.display()))?;
        if file_type.is_dir() {
            collect_rust_files_inner(&path, files)?;
        } else if file_type.is_file() && path.extension().is_some_and(|ext| ext == "rs") {
            files.push(path);
        }
    }
    Ok(())
}

fn should_skip_dir(path: &Path) -> bool {
    path.components().any(|component| {
        let part = component.as_os_str().to_string_lossy();
        part == "target" || part == ".git"
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use std::fs;

    fn write(dir: &Path, name: &str, content: &str) {
        let migrations = dir.join("migrations");
        fs::create_dir_all(&migrations).unwrap();
        fs::write(migrations.join(name), content).unwrap();
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let base =
            std::env::temp_dir().join(format!("mnt-gate-tenant-isolation-{tag}-{}", uuid_like()));
        fs::create_dir_all(&base).unwrap();
        base
    }

    fn uuid_like() -> u128 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }

    #[test]
    fn clean_tenant_table_passes() {
        let dir = tmpdir("clean");
        write(
            &dir,
            "0001_widgets.sql",
            "CREATE TABLE widgets (id uuid primary key, org_id uuid not null);\n\
             ALTER TABLE widgets ENABLE ROW LEVEL SECURITY;\n\
             ALTER TABLE widgets FORCE ROW LEVEL SECURITY;\n\
             CREATE POLICY org_isolation ON widgets \
                 USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid) \
                 WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);\n",
        );
        let result = check_migrations_root(&dir);
        assert!(
            result.passed(),
            "expected pass, got {:?}",
            result.violations
        );
    }

    #[test]
    fn org_column_without_rls_is_flagged() {
        let dir = tmpdir("noRls");
        write(
            &dir,
            "0001_w.sql",
            "CREATE TABLE w (id uuid primary key);\nALTER TABLE w ADD COLUMN org_id UUID;\n",
        );
        let result = check_migrations_root(&dir);
        assert!(
            result
                .violations
                .iter()
                .any(|v| v.kind == ViolationKind::OrgColumnWithoutRls)
        );
    }

    #[test]
    fn rls_without_force_is_flagged() {
        let dir = tmpdir("noForce");
        write(
            &dir,
            "0001_w.sql",
            "CREATE TABLE w (id uuid primary key, org_id uuid not null);\n\
             ALTER TABLE w ENABLE ROW LEVEL SECURITY;\n\
             CREATE POLICY org_isolation ON w \
                 USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);\n",
        );
        let result = check_migrations_root(&dir);
        assert!(
            result
                .violations
                .iter()
                .any(|v| v.kind == ViolationKind::RlsEnabledWithoutForce)
        );
    }

    #[test]
    fn rls_without_policy_is_flagged() {
        let dir = tmpdir("noPolicy");
        write(
            &dir,
            "0001_w.sql",
            "CREATE TABLE w (id uuid primary key, org_id uuid not null);\n\
             ALTER TABLE w ENABLE ROW LEVEL SECURITY;\n\
             ALTER TABLE w FORCE ROW LEVEL SECURITY;\n",
        );
        let result = check_migrations_root(&dir);
        assert!(
            result
                .violations
                .iter()
                .any(|v| v.kind == ViolationKind::RlsEnabledWithoutOrgPolicy)
        );
    }

    #[test]
    fn unclassified_table_is_flagged() {
        let dir = tmpdir("unclassified");
        write(
            &dir,
            "0001_w.sql",
            "CREATE TABLE mystery (id uuid primary key);\n",
        );
        let result = check_migrations_root(&dir);
        assert!(
            result
                .violations
                .iter()
                .any(|v| v.kind == ViolationKind::UnclassifiedTable)
        );
    }

    #[test]
    fn non_local_set_config_is_flagged() {
        let dir = tmpdir("nonlocal");
        write(
            &dir,
            "0001_w.sql",
            "SELECT set_config('app.current_org', 'x', false);\n",
        );
        let result = check_migrations_root(&dir);
        assert!(
            result
                .violations
                .iter()
                .any(|v| v.kind == ViolationKind::NonLocalGucMutation)
        );
    }

    #[test]
    fn local_set_config_passes_guc_check() {
        let dir = tmpdir("local");
        write(
            &dir,
            "0001_w.sql",
            "CREATE TABLE w (id uuid primary key, org_id uuid not null);\n\
             ALTER TABLE w ENABLE ROW LEVEL SECURITY;\n\
             ALTER TABLE w FORCE ROW LEVEL SECURITY;\n\
             CREATE POLICY org_isolation ON w USING (org_id = current_setting('app.current_org', true)::uuid);\n\
             SELECT set_config('app.current_org', 'x', true);\n",
        );
        let result = check_migrations_root(&dir);
        assert!(
            !result
                .violations
                .iter()
                .any(|v| v.kind == ViolationKind::NonLocalGucMutation),
            "transaction-local set_config must not be flagged: {:?}",
            result.violations
        );
    }

    #[test]
    fn dynamic_array_rls_credits_each_table() {
        let dir = tmpdir("dynamic");
        write(
            &dir,
            "0001_w.sql",
            "ALTER TABLE alpha ADD COLUMN org_id UUID;\n\
             ALTER TABLE beta ADD COLUMN org_id UUID;\n\
             DO $$\nDECLARE t TEXT;\n\
             tenant_tables TEXT[] := ARRAY['alpha', 'beta'];\nBEGIN\n\
             FOREACH t IN ARRAY tenant_tables LOOP\n\
               EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);\n\
               EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);\n\
               EXECUTE format('CREATE POLICY org_isolation ON %I USING (org_id = NULLIF(current_setting(''app.current_org'', true), '''')::uuid)', t);\n\
             END LOOP;\nEND\n$$;\n",
        );
        let result = check_migrations_root(&dir);
        assert!(
            result.passed(),
            "dynamic array RLS should classify alpha+beta as tenant tables: {:?}",
            result.violations
        );
    }

    #[test]
    fn audit_events_nullable_org_is_allowed_without_not_null() {
        // audit_events has an org_id + RLS but is in the nullable allowlist; it
        // must not be flagged unclassified and (with RLS/FORCE/policy) passes.
        let dir = tmpdir("audit");
        write(
            &dir,
            "0001_w.sql",
            "CREATE TABLE audit_events (id uuid primary key);\n\
             ALTER TABLE audit_events ADD COLUMN org_id UUID;\n\
             ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;\n\
             ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;\n\
             CREATE POLICY org_isolation ON audit_events USING (org_id = current_setting('app.current_org', true)::uuid);\n",
        );
        let result = check_migrations_root(&dir);
        assert!(
            result.passed(),
            "audit_events should pass: {:?}",
            result.violations
        );
    }

    #[test]
    fn global_allowlisted_table_is_not_unclassified() {
        let dir = tmpdir("global");
        write(
            &dir,
            "0001_w.sql",
            "CREATE TABLE auth_rate_limit (ip text, purpose text);\n",
        );
        let result = check_migrations_root(&dir);
        assert!(
            !result
                .violations
                .iter()
                .any(|v| v.kind == ViolationKind::UnclassifiedTable),
            "allowlisted global table must not be unclassified: {:?}",
            result.violations
        );
    }
}
