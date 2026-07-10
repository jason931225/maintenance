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

Cross-model codex review gates completion (same loop as M2).
