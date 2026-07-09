# Cedar/PBAC Activation — Design (architect pass, 2026-07-04)

Make the inert Cedar boundary (PR #171, `cedar_pbac.rs`) REAL, **shadow-first**, NO live authz change until explicit later promotion. `cedar-policy = "=4.11.2"` (language 4.5) re-verified live on crates.io 2026-07-04.

## Key facts
- The boundary + ALL fail-closed guards already exist + are unit-testable (`cedar_pbac.rs`: cedar_precondition_denial :662, preflight_denial :695, cedar_matches_map :731, cedar_decision :746, NotConfigured→BundleUnavailable). Missing: (1) a real adapter producing `CedarEvaluation::Allow/Deny/Error` replacing the `NotConfigured` sentinel (:324), (2) subject-freshness sourcing, (3) one shadow wiring site.
- Mostly wiring; reuse `policy_versions` (0065), `with_audit`, `metrics`, `org_runtime_flags` (0095).

## ⚠️ CRITICAL safety finding (HIGH — explicit test in slice 4)
`evaluate_cedar_pbac_boundary`'s `CedarShadowLegacyEnforce` arm SHORT-CIRCUITS to Cedar's deny BEFORE consulting legacy (`cedar_pbac.rs:600-604`). In shadow you must NOT enforce the boundary's returned effect. Wiring: legacy `authorize()` is the SOLE enforcer; the boundary result is an AUDIT-ONLY observation. A Cedar bug/error/stale-deny must NEVER change a live outcome. Slice-4 test: force Cedar `Error`/`Deny`, assert the legacy result is still returned.

## First enrollment: `identity.policy.role_manage`, mode cedar_shadow_legacy_enforce, dark
Independent of unmerged M2 #179; single chokepoint `authorize_org_manage` (`identity/rest/src/lib.rs:3141`, 11 guards route through it); trivial matrix (RoleManage = SUPER_ADMIN only → 1 generated policy → provable equivalence); hits the July-2026 RoleManage incident that motivated ADR-0021. Dark switch: `org_runtime_flag_enabled('cedar_pbac_shadow_role_manage')` (0095), ZERO enabled rows → production byte-identical. Coexistence-map JSON stays legacy_only; the runtime flag gates the shadow lane (flipping the map mode is a later promotion slice).

## Subject-freshness (blocker: Principal has no freshness today)
`SubjectFreshness` (cedar_pbac.rs:15) has all 4 dims; gap is sourcing. Model: token-snapshot (mint-time) vs DB-current (guard-time) → carried < current ⇒ StaleSubject deny.
- policy_version: REUSE policy_versions + get_policy_version/bump_policy_version_tx (identity/adapter-postgres:557,741).
- subject_version + session_generation: NEW `subject_authz_versions(org_id,user_id,version,session_generation,...)` mirroring policy_versions/0095 (FORCE RLS, org_isolation, GRANT SIU mnt_rt, REVOKE DELETE) + `bump_subject_version_tx(tx,org,user)` (upsert +1) called INSIDE the same with_audit txn as: role-assignment writes, employment lifecycle (0071/0092 via user_employee_link 0076), branch/team membership, credential/session events (refresh rotation, passkey add/remove, OTP → session_generation).
- step_up_generation: None for RoleManage pilot.
- Token claims: `#[serde(default)]` authz_subject_version/authz_policy_version/session_generation on AccessClaims + AccessTokenInput (auth/src/jwt.rs:72,362); mint from DB. 0-default legacy tokens hit MissingSubjectFreshness on cedar path — safe (shadow enforces legacy).
- Attach: `Principal.authz_freshness: SubjectFreshness` (lib.rs:549) set in resolve_principal_from_bearer_token (request-context:152).

## Bundle + real evaluation (new cedar_pbac::engine submodule)
- Schema (.cedarschema include_str!): Subject{org,roles:Set<String>,subject_version:Long}, Resource{org,branch?,resource_type}, actions, context. schema_version = hand-set string.
- Policy GENERATED from `Feature::matrix_row` (lib.rs:316) — single source of truth (no parallel hand-authored ruleset). RoleManage → one `permit ... when principal.roles.contains("SUPER_ADMIN")`.
- Compile→`Validator::validate(Strict)`: ANY error/warning ⇒ bundle NOT activated ⇒ bundle_key=None ⇒ BundleUnavailable deny (cutover §8 schema-backed rejection).
- bundle_digest=sha256(schema‖policy‖entity_template); `CompiledBundleCacheKey::new(org,policy_version,schema_version,digest,"4.11.2","4.5")` (:230).
- Cache: in-process HashMap<key,Arc<CompiledBundle>>, NO allow/deny cache (ADR §4). policy_version bump → new key.
- `engine::evaluate(req,bundle)->CedarEvaluation`: Entities from SERVER data only; Authorizer::is_authorized; wrap in Result + catch_unwind → any failure ⇒ Error{reason} (→ CedarError deny). bundle_key MUST equal map entry's key or StalePolicyBundle deny.

## Verification (9 readiness fixture cases → tests)
Map each cedar_pbac_readiness_cases.json case to a boundary assertion (logic exists): stale_policy, stale_subject, rls_separation, dual_engine_map_missing, dual_engine_disagreement, cedar_error, missing_freshness, missing_rls_scope_proof, malformed_coexistence_map. Plus: real mnt_rt RLS test (Cedar allow can't bypass RLS — adapter has NO set_config path); UI-projection test (policyProjection.ts policyProjectionCanAuthorize→literal false); metric_labels={effect,engine,reason,mode,domain} only.

## Slices (PR-sized, CI-verifiable; local cargo DISABLED → CI is authority)
1. **authz: Cedar dep + bundle compile/validate/digest + real engine::evaluate (TESTS ONLY, no live wiring).** No caller passes anything but NotConfigured yet → zero live change.
2. **Subject-freshness sourcing.** subject_authz_versions migration + bump/get helpers; additive AccessClaims; Principal.authz_freshness + resolve_principal; bump calls at existing with_audit sites.
3. **Coexistence-map loader (JSON→entries).** Expand multi-action→one entry per (domain,feature,resource_type); resolve bundle_key from slice-1; fail-close on action w/o Feature. Green: loader + 9 readiness bindings. Keep generic for workflow.guards later.
4. **Shadow wiring at authorize_org_manage.** Legacy-enforce-ONLY + isolated Cedar audit lane, dark flag (zero rows). Green: test proving legacy result returned even when Cedar forced Error/Deny (core safety proof) + mnt_rt RLS test.
5. **UI-projection + observation coverage.**
(1→3 parallelizable; 4 depends on 1-3; 5 alongside 4.)

## Genuine gaps (loader/spec-shape decisions)
1. Map actions UserRoleAssignmentWrite/PolicyRoleWrite have NO Feature variant → bind only RoleManage(+ElevatedRoleGrant) for pilot.
2. CoexistenceMapEntry needs one Feature + resource_type/entry, JSON has actions[] + no resource_type → loader expands + supply resource_type; add resourceType to JSON.
3. Audit field flattening: fixture mustAudit flattened names vs nested bundle_key → assert nested or serde flatten.
4. Action naming: Feature::as_str snake_case vs map PascalCase → pick Feature::as_str as Cedar action id.

## Promotion (OUT of scope — later program)
shadow → cedar_enforce_legacy_compare (first mode Cedar can deny live) → cedar_only, each evidence-gated (ADR-0021 §8). **Freshness rollover constraint:** don't promote to compare until all live tokens carry the new freshness claims (full token-TTL rollover), else an old 0-default token denies a legit SUPER_ADMIN in enforce mode.

### Mint-path freshness hardening (2026-07-08 — `feat/cedar-subject-freshness-hardening`)
The promotion blocker "non-login mints stamp ZERO freshness" is now CLOSED. Normal login/refresh already stamped real freshness via `load_user_auth_context_tx` (auth-rest). The three non-normal mints now source it too, via ONE shared read `mnt_platform_db::read_subject_authz_freshness(pool, org, user)` (arms the token's target org GUC through `with_org_conn`, reads `policy_versions` + `subject_authz_versions`, returns `(policy_version, subject_version, session_generation)`; absent rows → 0 baseline, same as login):
- **CLOSED** `platform-rest/view_as.rs` tenant-context START (writable SUPER_ADMIN) — reads freshness for `(target_org, operator_user)`.
- **CLOSED** `platform-rest/view_as.rs` view-as START (read-only impersonation) — same `(target_org, operator_user)`.
- **CLOSED** `auth-rest` `start_group_admin_tenant_context` handler (writable bounded ADMIN) — reads freshness for `(target_subsidiary_org, actor_user)`, then mints via `issue_group_admin_tenant_context_access_token` with the already-sourced values.

Invariant relied on: the shadow guard (`authorize_org_manage_observed` → `get_policy_version()` + `get_subject_authz_versions(principal.user_id)` under the token's armed org) re-reads the SAME `(org,user)` from the SAME tables, so a just-minted token has carried == DB-current and clears the freshness gate. For these cross-tenant mints the subject (operator/actor) has no `users` row in the target tenant, so `subject_version`/`session_generation` are the true absent-0 baseline while `policy_version` (org-keyed) is real — sufficient material to avoid `MissingSubjectFreshness` whenever the target org has any custom-policy revision. Tests: `platform-rest/tests/view_as.rs` (real HTTP drive of both platform mints, `mnt_rt`) + `auth-rest/tests/group_admin_tenant_context.rs` (real `start_group_admin_tenant_context` handler drive as `mnt_rt`, asserts the seeded `policy_version` flows onto the minted token + reflects a live bump) + `backend/app/tests/cedar_freshness_mint.rs` (helper read as `mnt_rt`, group-admin issuer seam, boundary satisfies + `StaleSubject`-after-bump).

Deferred follow-ups (still zero / out of this lane):
- **Session-invalidation bumps** — passkey-removal and logout do NOT yet bump `session_generation` (the auth crate has no bump helper; this is a session-revocation policy, not a mint-freshness gap). Until added, `session_generation` cannot gate a revoked session on the Cedar path.
- **dev-auth mint** — the `#[cfg(feature="dev-auth")]` role-switch endpoint still stamps 0 (not in release builds; `mnt-gate-dev-auth-absence` keeps it out of prod).
- **`step_up_generation`** — still `None` everywhere (MFA-freshness feature; explicitly out for the RoleManage pilot).

Cross-model codex review gates completion (same loop as M2).

### Enrollment wave 2 (2026-07-09 — `feat/cedar-enrollment-parity`)

Slice 4 wired ONE surface (identity `role_manage`) into a Cedar shadow. Wave 2 EXTENDS the shadow to two more surfaces and adds the promotion-evidence artifact. All still audit-only, legacy still the SOLE enforcer, per-tenant DARK flags (zero enabled rows in prod), whole-lane `catch_unwind` isolation — the #182 discipline, generalized.

**Engine generalization** (`authz/cedar_pbac/engine.rs`): `compile_bundle_for_feature(org, policy_version, feature)` + `feature_schema(feature)` emit a strict-validated bundle for ANY enrolled `Feature` (action id = `Feature::as_str`), policies still GENERATED from the legacy matrix (`generate_policies`) so Cedar ≡ matrix by construction. `role_manage`'s pinned bundle identity is untouched (separate path), so #182 stays byte-identical. Test: `per_feature_bundle_matches_the_legacy_matrix` (SUPER_ADMIN allow / MEMBER deny across work_order_read_all, user_manage, completion_review, approval_finalize) + distinct-key test.

**Shared observer** (`app/src/cedar_parity.rs`): `observe_parity(pool, principal, org, feature, resource, domain, flag_key, legacy_allowed)` — flag-gated, reads DB-current freshness (`policy_versions` + `subject_authz_versions`) like #182, compiles the per-feature bundle, evaluates Cedar in **`CedarOnly`** mode (Cedar's OWN verdict incl. preconditions, NOT folded with legacy), and records a self-contained `ParityObservation {domain, action, resource_kind, principal_roles, legacy_effect, shadow_effect, shadow_reason, divergent}` into `audit_events` (action `authz.cedar_pbac_parity`) via `with_audit`. Returns `()` — never gates. CedarOnly is the parity primitive: "if Cedar were sole enforcer, would it match the legacy verdict the caller already enforced?"

**Enrolled surfaces (coverage NOW):**
- **Engine decide path** — `workflow_studio.rs`: `claim`/`decide` (via `observe_task_decide_parity`, feature from the task `required_policy`), `finalize` (`ApprovalFinalize`), `post_finalization_rejection` (`ApprovalFinalize`). Observes the legacy-ALLOW direction (the flip-risk direction) post-guard; the legacy-DENY direction on these handlers 403s before the observer (see remaining).
- **Read surface** — `objects.rs` `resolve_object`: the capability-gated kinds (work_order/equipment → `WorkOrderReadAll`, account → `UserManage`), observed BEFORE the kind-level 403 so BOTH allow and deny directions are measured. Non-capability kinds (support_ticket/org_unit/person/approval_run/passkey/consent) are pure branch-scope/RLS visibility with no capability verdict to compare — intentionally not enrolled (Cedar never replaces RLS row isolation).

**Evidence artifact** (`bin/mnt-cedar-parity-report`, read-only, NO REST/OpenAPI): aggregates `authz.cedar_pbac_parity` rows into per-site (org) `{total, agree, disagree, divergences[], clean}` + total/disagree. `aggregate()` is pure + unit-tested; the binary is thin glue (SQL SELECT identical to the DB test's read + `aggregate` + pretty JSON). `CEDAR_PARITY_FAIL_ON_DIVERGENCE=1` → exit 2 (usable as a promotion CI gate); `CEDAR_PARITY_ORG=<uuid>` arms one tenant's GUC. DB test `divergence_is_recorded_and_report_surfaces_it` seeds a MEMBER allow-by-legacy / deny-by-cedar divergence and asserts the report surfaces it; `agreement_is_recorded_and_site_reports_clean` proves the clean signal; org-scope + dark tests round it out (all `mnt_rt`, FORCE RLS).

**Remaining surfaces (NOT yet enrolled):** decide-path legacy-DENY direction (403 short-circuits before the observer — the read surface already covers both directions); the object-graph per-node resolves (N-per-request, deferred as noise); every other legacy gate (`authorize_workflow_manage` admin routes, domain read gates beyond work_order/equipment/account). Each is a data/wiring increment on the same shared observer, not new machinery.

**Promotion criteria (per site):** a site may flip `object.resolve` / `workflow.decide` from shadow → `cedar_enforce_legacy_compare` only after a **sustained zero-divergence window** — `mnt-cedar-parity-report` shows that site `clean` (disagree == 0 with a non-trivial `total`) across the full token-TTL rollover (so every live token carries real freshness; a 0-default token would otherwise deny a legit principal in enforce mode — same constraint as the freshness section above). Divergences with `shadow_reason` = `stale_subject`/`missing_subject_freshness` are freshness-plumbing gaps (fix the mint path), NOT policy divergence; `cedar_denied`/`cedar_allowed` disagreements are true policy gaps to reconcile before promotion. Promotion itself remains a separate charter (this lane only MEASURES).
