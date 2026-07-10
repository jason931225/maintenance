# Lane: Cedar subject-freshness mint-path hardening

Branch `feat/cedar-subject-freshness-hardening` (worktree `.worktrees/cedar-freshness`, off origin/main e54377e6).
Owner: session 6fe889fb (autonomous drive). Disjoint from the live Oyatie/notifications lead (a28cfdf2).

## Why
Cedar/PBAC shadow lane (#182, merged, dark) will one day be promoted to enforcing. Under any enforcing mode a token carrying zero/absent subject-freshness is denied (`MissingSubjectFreshness`), and a token whose carried snapshot < DB-current is denied (`StaleSubject`). Normal login/refresh already stamp REAL freshness (`load_user_auth_context_tx`, auth-rest). The hard promotion blocker: the non-normal mint paths stamp ZERO. Close them so every production-reachable access token carries real freshness — additive, shadow stays dark, ZERO live-authz change.

## Infra on main (locate by symbol; survey line numbers were off origin/main)
- `SubjectFreshness{policy_version, subject_version, session_generation, step_up_generation:Option}` — `platform/authz/src/cedar_pbac.rs`. `.has_subject_material()`, `.satisfies(req)`.
- Token carried fields `authz_policy_version/authz_subject_version/session_generation` (`#[serde(default)]`) on `AccessClaims`/`AccessTokenInput` — `platform/auth/src/jwt.rs`.
- Real-freshness read the LOGIN path uses: `load_user_auth_context_tx` (auth-rest) reads `subject_authz_versions` (subject_version+session_generation) + `policy_versions` (policy_version).
- Adapter reads: `get_subject_authz_versions(user)`, `get_policy_version()` (identity/adapter-postgres). NOTE they read under the *ambient* armed org — view-as crosses orgs, so a target-org-armed read is needed.
- Shadow guard reads DB-current at guard time: `get_policy_version()` + `get_subject_authz_versions(principal.user_id)` under the token's armed org (`identity/rest/src/lib.rs` ~authorize_org_manage_observed). Carried must match this read for a fresh token to NOT trip a false stale/missing.

## Scope (close all three)
1. **`platform-rest/src/view_as.rs` tenant-context START** (writable SUPER_ADMIN, `view_as:false,read_only:false`) — `issue_access_token_with_ttl` stamps zero. Source real freshness for the token's (target_org, subject-user), arming target_org RLS GUC.
2. **`platform-rest/src/view_as.rs` view-as START** (read-only impersonation) — same fix.
3. **`auth-rest/src/lib.rs` group-admin tenant-context** (`issue_group_admin_tenant_context_access_token`, writable bounded ADMIN) — stamps zero → source real freshness for (target.org_id, actor).

Design: add ONE shared read helper keyed by explicit (org, user) → `(policy_version, subject_version, session_generation)` arming that org's GUC (reuse existing SQL/helpers). Wire into the 3 sites. DO NOT refactor the working login/refresh read. Consistency invariant: mint reads the SAME source-of-truth the shadow guard reads, so a just-minted token satisfies freshness.

## Tests (enterprise bar — blocking)
- In `backend/app/tests/` following `cedar_shadow_role_manage.rs` pattern; real `mnt_rt` pool (`SET ROLE mnt_rt`, arm `app.current_org`). NEVER BYPASSRLS/superuser.
- Prove each of the 3 mints now stamps non-zero freshness == DB-current for the token's (org,user).
- Prove a token minted via view-as/tenant-context carries freshness that `.satisfies()` the guard-time requirement (no `MissingSubjectFreshness`/`StaleSubject` for a fresh token) — i.e. the shadow lane stays silent for a legit fresh operator token.

## Out of scope → follow-up lanes (record in cedar-activation-design.md Promotion section)
- Passkey-removal + logout `session_generation` bumps (session-invalidation policy, not a mint-freshness gap; auth crate lacks the bump helper).
- Dev-auth zero-stamp (`#[cfg(feature="dev-auth")]`, not in release).
- `step_up_generation` sourcing (MFA-freshness feature; explicitly None for RoleManage pilot).

## Constraints
Local cargo build/test/clippy/run DISABLED (CI is authority) — do NOT run them; `cargo fmt` allowed. Don't touch `identity/rest` (lead collision). Don't commit `docs/design/**`. Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. After implement: separate codex + verifier review, then push/CI-green/merge.
