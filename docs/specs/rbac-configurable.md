# RBAC — Configurable Roles & Policy (design sub-spec)

> **Status:** DESIGN — adversarial security-review DONE (verdict **NOT-YET — HIGH**: 3 CRITICAL +
> 4 HIGH + 3 MEDIUM); revisions §0.1 below fold every must-fix into the design. **Re-review the
> revised spec before P1 code** (P0 = code-only hygiene, see §9). The G002 pattern: kill the HIGHs
> pre-code.
> **Parent:** `SPEC.md`, `docs/specs/knl-business-os.md`, `docs/specs/org-hierarchy.md`.
> **Trigger:** user directive 2026-06-24 — *"should allow new / custom roles with
> configurable permissions / policy"*, generalizing the *"add an org-admin grant"*
> decision into a data-driven RBAC. **Quality bar:** Palantir-grade, enterprise-production.

## 0.1 Security-review revisions (must-fix, folded into the design)

The pre-code security-review found the model would ship with **silent privilege-escalation and
parity holes**. The dominant discovery: **authorization on a role STRING/variant is pervasive today
(18 sites)** — and the dangerous ones are not the obvious `is_admin_like`, but the **"grant ≤ self"
guard itself, the OTP/credential-reset privileged-target gates, and a money-path approval router** —
each of which silently breaks or is bypassed once roles become renamable/custom. Each must-fix is now
binding:

- **R1 (C1) — Ban role-string authorization.** *No authorization decision may branch on a `Role`
  variant or role string.* Every one of the 18 enumerated sites converts to a capability check. The
  scary ones (must convert in the RBAC slice, **before** any custom role can be assigned in prod):
  `identity/rest:787` (`authorize_user_write` — the live "grant ≤ self" enforcement, blind to a
  custom super-role), `auth-rest:990/993` (`issue_admin_otp`) + `auth-rest:1083/1086`
  (`admin_credential_reset`) privileged-target tests (→ account takeover of a custom-super account),
  `financial:1574-1586` (`purchase_actor_for_user_tx` role-string cascade that drives the purchase
  approval state machine), `financial:1675` (self-approval exemption), `registry/rest:166/1350`
  (`all_branches` substitute search). Plus the **~13 `BranchScope::All`-from-role producers** (see R6).
  A new CI gate (sibling of `mnt-gate-rls-arming`) **fails on any `matches!(*, Role::…)` / `role ==
  "…"` / `.roles.contains(Role::…)` outside the authz resolver**.
- **R2 (C2) — Escalation closure.** "Grant ≤ self" is checked over the **post-union effective
  capability set** at **assignment time**, against the **assigner's live resolved set** (never the
  role author's). `RoleManage` is **self-bounded**: it confers only the ability to grant the subset
  the assigner currently holds. Assigning ANY role conferring a capability whose system-default cell
  is `[D,D,D,D,D,A]` (a named, `matrix_row()`-derived elevated allow-list incl. `ElevatedRoleGrant`,
  `RoleManage`, `UserManage`) requires the actor to hold `ElevatedRoleGrant`. Role **creation** is not
  a grant — the assignment guard is the sole choke point and checks every conferred capability.
- **R3 (C3) — Token / `users.roles` / `Role::from_str` collision.** `users.roles` is a `text[]` with a
  hard 6-value CHECK (`0046_…`), the token claim is literally `user.roles.clone()`, and every extractor
  maps via `Role::from_str` (401 on unknown) — so custom slugs **cannot** ride `users.roles` or the
  token through `Role`. Resolution (binding): **`user_role_assignments` is the source of truth**
  (RLS-armed); `users.roles` + its CHECK stay **system-only**; the resolver unions system-role policy
  (from the token's built-in roles) with custom-role assignments **read from DB per request**; custom
  keys **never** flow through the `Role` enum; **key→policy is parse-or-deny** (any key/feature/level
  not resolving to a live row under armed RLS contributes **zero** capabilities — never most-permissive).
- **R4 (H1) — Revoke is globally effective.** Cache key = `(org_id, policy_version)`; every
  `RoleManage` write **synchronously bumps a per-org `policy_version`** (RLS-armed row) before
  returning; resolution reads the version (one cheap armed read, deny on failure) and treats a mismatch
  as a miss. No reliance on per-process TTL/in-node invalidation for a revoke. (Moved from "later" into
  **P1**.)
- **R5 (H2/H4) — No-lockout, hardened + parity-proofed.** The floor is "≥1 **active** user whose
  **effective** capability set (union over assignments) includes **both** `RoleManage` **and**
  `ElevatedRoleGrant`"; the holder-count check runs under a per-org advisory lock / serializable tx
  (kills the concurrent-revoke TOCTOU). Seed parity: a **golden test over the full `Role::ALL ×
  Feature::ALL` grid keyed by enum** (not column index); catalog growth **upserts** new `matrix_row()`
  cells into every org's `kind='system'` rows (idempotent) and re-asserts `SUPER_ADMIN`'s full `Allow`
  set.
- **R6 (H3) — One `BranchScope::All` decision point.** Exactly one shared capability-driven function
  derives `BranchScope::All` from holding the relevant `*OrgWide` capability; **every** producer routes
  through it — the REST queue scope (`work_order_list_scope`), the **evidence** widen
  (`workorder/rest:1706`), the realtime widen (`realtime:1035`, a raw-string second copy **outside** the
  org middleware), `resolve_branch_scope_in_org` and all ~13 per-crate copies, and the
  `support/rest:272/603` consumers. Collapse the duplicates.
- **R7 (M1) — Catalog is referential + parse-or-deny.** `role_permissions.feature`/`level` reference a
  `feature_catalog` table seeded from `Feature::ALL` (FK), single-sourcing the catalog; the resolver
  drops any unparseable `feature`/`level` to `Deny`.
- **R8 (M2) — Prove the cache-warm read is armed.** The per-org policy warm-load must be armed in-tx and
  tested as **real `mnt_rt`**; a bare-pool warm must yield deny-all (proving arming is load-bearing —
  the `resolve_branch_scope_in_org` footgun). Add the 3 tables + `policy_version`/`feature_catalog` to
  `mnt-gate-rls-arming`.
- **R9 (M3) — `view_as` stays system-roles-only.** Operator impersonation
  (`platform/platform-rest/view_as.rs`) must never mint arbitrary custom-role tokens without re-deriving
  effective capabilities under the target org's RLS. Stated as an explicit guard.

**Sound (keep):** tier separation (no `PlatformFeature→Feature` bridge; `PlatformPrincipal` carries no
role/scope), default-deny composition, `repository_filter` empty-scope = `FALSE`. The
`role_permissions.feature` CHECK references only `Feature`, **never** `PlatformFeature`.

## 0. Today's model (what we are changing)

RBAC is **100% compile-time** today:

- `Role` is a fixed 6-variant enum: `SUPER_ADMIN, ADMIN, MECHANIC, RECEPTIONIST, EXECUTIVE, MEMBER`
  (`crates/platform/authz/src/lib.rs`).
- Permissions are a `const fn matrix_row()` — a `[PermissionLevel; 6]` per `Feature` (~40 features),
  columns `[MEMBER, RECEPTIONIST, MECHANIC, ADMIN, EXECUTIVE, SUPER_ADMIN]`. `permission_for(role,
  feature)` indexes it; `authorize()` checks role-permission **and** branch membership.
- A user's roles ride in the **verified JWT** (`AccessClaims.roles` → `Role::from_str`); branch scope
  is resolved per-request from `user_branches` (`resolve_branch_scope_in_org`: only `SUPER_ADMIN` /
  `EXECUTIVE` → `BranchScope::All`).
- **There is no `roles` table, no `role_permissions` table, no DB role model.** Policy is code.

This is correct, auditable, and fast — but **not configurable**. A conglomerate of legal entities in
different industries (물류 / 제조·OEM / 파견·용역 / …) needs per-tenant roles ("현장소장", "배차데스크",
"노무담당", "구매과장") with tenant-specific policy. This sub-spec introduces a **data-driven role +
policy layer** while preserving every isolation and escalation guarantee the compile-time model gives.

## 1. Objective & non-goals

**Objective.** A per-tenant administrator (with the new `RoleManage` capability) can, **through the
audited console** (never SQL): create/edit/retire **custom roles**, set each role's **policy** (which
capabilities, at which `PermissionLevel`, plus scope reach), and **assign** roles to users — with
default-deny, least-privilege, and full audit. The built-in 6 remain as **immutable system roles**;
custom roles layer on top. The authz engine resolves a principal's effective permissions from the
**effective policy** (system defaults ∪ tenant custom roles) instead of the static matrix.

**Non-goals (this slice).**
- **No user-defined capabilities.** Custom roles **compose the existing `Feature` catalog** (the ~40
  capabilities already in code). Inventing *new* capability primitives belongs to the later
  **ontology-actions** layer (action/write-back engine, G010), not here. The capability set is the
  fixed, code-reviewed vocabulary; only their **grant** is configurable.
- **No change to the tenant/org boundary.** RLS org-isolation is immutable and **not policy-driven**.
- **No platform-tier configurability.** `PlatformFeature` / `PlatformPrincipal` stay separate and fixed.
- **No AI.** (Foundry reference is pre-AI.)

## 2. Data model (per-tenant, RLS-armed)

New migration (next free number; **renumber at implementation time** to avoid collision — last seen
0058). All tables are tenant-scoped, `FORCE ROW LEVEL SECURITY`, `org_id` column, owner-applied,
`GRANT`ed to `mnt_rt`, RLS policy `org_id = current_setting('app.current_org')::uuid`.

```
roles
  id uuid pk
  org_id uuid not null                       -- tenant boundary (RLS)
  key text not null                          -- stable slug, unique per org; system keys reserved
  display_name text not null                 -- shown in console (Korean copy lives in ko.ts, not here)
  kind text not null                         -- 'system' | 'custom'  (system rows immutable)
  is_assignable boolean not null default true
  created_at / updated_at / created_by
  unique (org_id, key)

role_permissions
  role_id uuid fk -> roles
  org_id uuid not null                       -- RLS (denormalized for armed reads)
  feature text not null                      -- MUST parse to a known Feature; CHECK against catalog
  level text not null                        -- 'deny'|'limited'|'request_only'|'allow' (PermissionLevel)
  unique (role_id, feature)

user_role_assignments
  user_id uuid fk
  role_id uuid fk -> roles
  org_id uuid not null                       -- RLS
  granted_by uuid / granted_at
  unique (user_id, role_id)
```

- **System roles** are seeded (migration) as `kind='system'` rows per org with `role_permissions`
  exactly mirroring today's `matrix_row()` — so day-0 behavior is byte-identical. System rows are
  **immutable** (DB rule / app guard: no UPDATE/DELETE of `kind='system'`; their permissions are the
  baseline floor and the upgrade target if the catalog grows).
- A user's **effective policy** = union over assigned roles of `max(level)` per feature (most-permissive
  wins, same as today's "any role satisfies"). Scope reach (branch vs org) is a property of the role
  (see §5 `OrgWideQueueTriage`) resolved into `BranchScope`, **never** a way to cross `org_id`.

## 3. Authz engine change

- `permission_for(role, feature)` and `authorize()` keep their **signatures**, but effective levels come
  from the **resolved tenant policy** (DB), not `matrix_row()`. `matrix_row()` survives as the **seed +
  the system-role floor** (single source for the migration + a compile-time default if policy is absent).
- Resolution is **per-request, RLS-armed, and cached**: load the tenant's role→permission map once
  (short-TTL cache keyed by `org_id`, invalidated on any `RoleManage` write) so the hot path stays O(1)
  and never does an unarmed read. The Principal already carries resolved roles; we additionally resolve
  the **effective capability set** (or resolve lazily in `authorize`).
- **Fail-closed:** unknown feature string, missing policy row, unarmed read, or cache miss under load →
  **deny**, never allow. Default for any (role,feature) not present = `Deny`.

## 4. Hard invariants (NON-NEGOTIABLE — a security-reviewer must verify each)

1. **Tenant isolation is immutable.** No role, policy, or assignment can read/write across `org_id`.
   All three new tables are FORCE RLS + armed + have `mnt_rt` tests proving cross-tenant invisibility.
   Policy configures *capabilities within a tenant*, never the tenant boundary.
2. **No privilege escalation via configuration.** Defining/assigning a role can **never grant a
   capability the actor does not themselves hold** ("grant ≤ self"). Enforced server-side on every
   `RoleManage` write, audited, and tested (T: admin cannot mint a role with `ElevatedRoleGrant` or
   `SUPER_ADMIN`-only capabilities and assign it to self/another).
3. **System roles immutable; capability catalog fixed.** Only the **assignment** of the existing
   `Feature` set is editable. No SQL/console path creates a new `Feature`. `SUPER_ADMIN` retains the
   full set; `kind='system'` rows cannot be edited/deleted.
4. **No lockout.** The system guarantees at least one assignable role in each org holds `RoleManage`
   **and** `ElevatedRoleGrant` (the system `SUPER_ADMIN`); a `RoleManage` write that would remove the
   last such grant is rejected.
5. **`ElevatedRoleGrant` still gates elevation.** Assigning a role that confers elevated capabilities is
   itself an elevated action (matrix: `ElevatedRoleGrant` = `SUPER_ADMIN` only). Self-approval rule
   unchanged: only 대표/CEO + `SUPER_ADMIN` may self-approve (see [[operations-through-console-only]]).
6. **Platform tier untouched.** No bridge from `PlatformFeature` to `Feature`; platform principals carry
   no role/policy.
7. **Everything audited.** Every role create/edit/retire/assign/unassign emits an `AuditEvent`
   `.with_org(org)` (arms the GUC) — through the console API, never direct SQL.

## 5. New capabilities (compose the existing catalog)

Two new `Feature` variants (matrix cells default to **least-privilege**, then become tenant-configurable):

- **`RoleManage`** — define/edit/retire custom roles + assign roles to users. Default cells
  `[D,D,D,D,D,A]` (**SUPER_ADMIN only**). The console role-editor + assignment UI gate on this.
- **`OrgWideQueueTriage`** — read the **org-wide** work-order + daily-plan queues regardless of branch
  membership (the legitimate "central triage desk" reach). Default cells `[D,D,D,D,A,A]`
  (**EXECUTIVE + SUPER_ADMIN**, matching `resolve_branch_scope_in_org`'s org-wide set). This is the
  **bridge fix for the codex HIGH-1 finding**: `work_order_list_scope()` returns `BranchScope::All`
  **iff** the principal holds `OrgWideQueueTriage` (replacing the hardcoded `is_admin_like → All`
  widen). Day-0 effect: branch `ADMIN`s become correctly branch-scoped; org-wide triage flows to
  EXEC/SUPER_ADMIN. Once configurable RBAC ships, **"org-admin" is simply a custom role with
  `OrgWideQueueTriage = Allow`** — the user's chosen "org-admin grant", now data-driven.

> **Live migration note (HIGH-1):** before shipping the un-widen, confirm KNL's current triage user.
> If they are a plain branch `ADMIN`, elevate them (EXECUTIVE) or grant the forthcoming org-admin role
> in the same change — do **not** silently shrink their live queue. Surface, don't drop.

## 6. Console UX (Blueprint, AA, visual-verdict ≥90)

- **Roles page** (gated on `RoleManage`): list system + custom roles; create/edit a custom role via a
  capability matrix editor (feature × level, grouped by domain) with a **diff-from-baseline** view and
  a **"grant ≤ self" preview** that greys out capabilities the actor lacks. Retire (not hard-delete)
  custom roles that still have assignments only after reassignment.
- **User detail**: assign/unassign roles (multi-role), each assignment audited; show effective
  capabilities (read-only rollup) so an admin sees the *net* of multiple roles.
- Copy in `ko.ts`; no raw UUIDs (`safeLabel`/`ObjectLink`); KST timestamps; loading/empty/error states.

## 7. Migration & compatibility

- Seed `kind='system'` roles + `role_permissions` from `matrix_row()` for every existing org (and on
  tenant-create), under a golden full-grid parity test keyed by enum (**R5**). Existing users' role
  strings map 1:1 to the seeded system roles → **zero behavior change at cutover** (byte-identical
  policy), then custom roles are additive.
- **Per R3:** the token continues to carry only the **built-in role identifiers** (`users.roles` stays
  system-only, CHECK unchanged); **custom-role assignments live in `user_role_assignments`** and the
  resolver unions system-role policy (from the token) with those per-request armed reads. Custom keys
  never flow through `Role::from_str`; key/feature/level resolution is **parse-or-deny**. Cache is keyed
  by `(org_id, policy_version)` (**R4**).

## 8. Threat model — what the security-review must adversarially probe

- Cross-tenant: can org A's admin create/read/assign a role in org B? (RLS + armed-read tests.)
- Escalation: can a non-SUPER_ADMIN mint/assign a role exceeding their own grant? self-grant
  `ElevatedRoleGrant` / `RoleManage`? assign a system-equivalent super role?
- Lockout/DoS: can a sequence of edits leave an org with no `RoleManage` holder?
- Confused-deputy: does any existing endpoint authorize on a **role string** rather than a **capability**
  (so a renamed/custom role bypasses it)? (Audit every `matches!(role, …)` call-site; `is_admin_like`
  is one — convert to capability checks.)
- Cache poisoning / staleness: can a revoked capability remain effective past invalidation? fail-open on
  cache miss? (Must fail-closed.)
- Catalog injection: can a crafted `feature` string enable an unintended capability or bypass the
  `Feature` CHECK? (Parse-or-deny.)

## 9. Phased delivery (new ultragoal goal — slots after G002 org-hierarchy)

0. **P0 — capability hygiene + HIGH-1 bridge (ships in G001/now, code-only, no new tables):** add
   `OrgWideQueueTriage`, route the workorder queue/daily-plan `BranchScope::All` widen through it (the
   `is_admin_like` today-holes), fix codex HIGH-2 (gate `list_daily_plans` on
   `DailyPlanRequest`∪`DailyPlanReview`) — all with `mnt_rt` tests. Closes the live finding
   forward-compatibly. *(Scope here is only the workorder today-holes; the full R1/R6 conversion is P1.)*
1. **P1 — de-string authorization + the `BranchScope::All` chokepoint (R1, R6) + data model + engine:**
   convert **all** 18 role-string sites to capability checks — especially the escalation/IDOR guards
   (`identity/rest:787`, `auth-rest` OTP/credential gates, `financial` approval router) — and collapse
   the ~13 `BranchScope::All`-from-role producers into one capability-driven decision fn; add the CI gate
   forbidding role-string authz. Then: migration (3 tables + `feature_catalog` (R7) + per-org
   `policy_version` (R4), RLS, GRANTs, seed-from-`matrix_row()`), resolver + `(org_id,policy_version)`
   cache, fail-closed parse-or-deny. `mnt_rt` RLS tests incl. the **armed cache-warm** proof (R8) and the
   golden full-grid parity test (R5). Add the new tables to `mnt-gate-rls-arming`.
2. **P2 — RoleManage API + escalation closure (R2) + no-lockout (R5):** create/edit/retire/assign
   endpoints (openapi-first, regen clients); grant-≤-self over the post-union effective set at assignment
   time; `RoleManage` self-bounded; named `[D,…,A]` allow-list gates assignment; holder-floor under
   advisory-lock/serializable. Full audit. Escalation + concurrent-revoke + lockout tests. **Gate:
   custom-role assignment must NOT be enabled in prod until every R1 escalation-guard conversion (P1) has
   landed + been re-reviewed** — else a custom super-role bypasses the OTP/credential/grant guards.
3. **P3 — console UX:** Roles page + capability editor (grant-≤-self preview) + user role-assignment
   (Blueprint, AA, ≥90).
4. **P4 — "org-admin" as first custom role** (`OrgWideQueueTriage=Allow`; proves the loop) + docs.

**Test strategy (per slice):** real `mnt_rt` RLS round-trip + cross-tenant invisibility for each new
table; golden parity test that seeded system policy == `matrix_row()`; adversarial escalation/lockout
tests; gates + fmt + clippy + `check:openapi-app` green; security-review as a separate pass.

## 10. Open decisions (recommended defaults in **bold** — confirm or override)

1. **Capability granularity:** **compose existing `Feature` catalog only** (new capabilities deferred to
   ontology-actions / G010). _Alt: allow defining new capability primitives now (much larger; couples to
   the action engine)._
2. **Role locus:** **per-tenant custom roles first**; group-level shared roles (define once, apply across
   subsidiaries) as a follow-on tied to `org-hierarchy.md` group grants. _Alt: build group-level now._
3. **Built-ins:** **immutable system roles + custom on top** (no lockout, safe upgrades). _Alt: fully
   editable built-ins (rejected — lockout/upgrade risk)._
4. **Multi-role users:** **yes, union-of-roles, most-permissive-per-feature** (matches today's "any role
   satisfies"). _Alt: single role per user (simpler, less flexible)._
5. **Scope reach as policy:** **model org-wide reach as the `OrgWideQueueTriage` capability** (and future
   `*OrgWide` capabilities), not a free-form scope DSL — keeps RLS the hard floor. _Alt: per-role scope
   expression (more power, larger attack surface)._
