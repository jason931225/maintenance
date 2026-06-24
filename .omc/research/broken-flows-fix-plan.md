I have confirmed the gate's full surface: it is purely a textual bare-pool-executor matcher. It never inspects the `org_id` value passed into `with_audit`/`with_org_conn`, and `audit_tx.rs` treats `event.org_id == None` as a silent no-op (GUC left unset). This confirms every gate-hole and root-cause claim. I have enough to write the spec.

---

# KNL #19 — Five Broken Flows: Root-Cause Synthesis & Fix Spec

## 1. Common root cause? — NO single cause. Three distinct classes.

**The headline finding: none of the five is a missing-`.with_org` / unarmed-read RLS bug.** Every write is armed and every read is armed. The shared *symptom* ("success toast, then invisible") has three different mechanisms:

| Class | Flows | Shared cause |
|---|---|---|
| **A. Org-value mismatch (write org ≠ read org)** | **#19.21 sales/rental inquiry** | The write is armed but to the **wrong org**. Public storefront hard-pins `scope_org(OrgId::knl())` (sales/rest:201) so the row lands under the fixed `0x…a1` uuid; staff read scopes to their JWT `org` (`current_org()`). For any tenant minted by `platform_create_organization()` (random `gen_random_uuid()`), the orgs never match → FORCE-RLS hides the row. This is the only flow where RLS *mechanics* participate in the hiding, but it is a **wrong-sentinel** defect, not an arming defect. |
| **B. Read surface filters out the freshly-created row (correct org)** | **#19.13 work-order**, **#19.17 daily plan**, **#19.22 PM schedule** | Row is written correctly and *would* be returned by a properly-scoped read in the same org, but an over-narrow read filter excludes it: WO → JWT **branch-scope** excludes `body.branch_id`; daily plan → **no list endpoint at all** + the only list filters `status IN (APPROVED, FINAL_CONFIRMED)` excluding DRAFT/REQUESTED; PM schedule → UI **date window** `[today, today+30)` excludes past/far-future `due_date`. |
| **C. Create 4xxes before any row exists (UI swallows the error)** | **#19.18 purchase request** | Not invisibility — a strict precondition (`worm_replica_status='VERIFIED'` synchronously, financial/adapter:915) rejects the create, and the web `catch{}` discards `response.error` (PurchaseRequestPanel:122). Operator sees "won't create" with no reason. |

So: **group B is the dominant cluster (3 of 5)** — admin-facing read surfaces that are too narrow. A and C are singletons.

## 2. Gate hole — why `mnt-gate-rls-arming` is irrelevant here, and the two holes to close

The gate (`backend/ci/gates/rls-arming/src/lib.rs`) is **purely a textual bare-pool-executor matcher**: it flags `.fetch_*/.execute(` whose executor arg is in `BARE_POOL_ARGS` (`&self.pool`, `self.pool()`, `&pool`, `pool`) and nothing else. It **never inspects the `org_id` carried by the `AuditEvent`/`with_org_conn`**. Crucially, `audit_tx.rs:71-73` treats `event.org_id == None` as a **silent no-op** — GUC left unset, but a `with_audit(...)` call is present, so the gate sees an armed-looking call and passes.

None of these 5 bugs would have been caught because none is a bare-pool read. But two real holes exist that let the *adjacent* class (`create_internal_ticket`) and #19.21 through:

- **Hole 1 — armed-with-`None`/armed-with-wrong-org:** a `with_audit`/`with_org_conn` whose `AuditEvent` was built **without `.with_org`** (org_id `None` → GUC never set → fail-closed-invisible) OR with a **hardcoded literal org** (`OrgId::knl()`, the #19.21 hole) is invisible to the gate. The text `with_audit(` is present, so it looks armed.
- **Hole 2 — last-wins masks intent:** `with_org` is last-wins (`audit.rs:127`), so an app-layer `.with_org(OrgId::knl())` default is silently overridden by a call-site `.with_org(org)` — good when the override exists, **catastrophic when it's forgotten** (you keep the `knl()` literal).

**Close it** with a new lint (extend the gate, or a sibling `mnt-gate-org-binding`):
1. Every `AuditEvent`/`*_audit_event(...)` builder that targets a tenant table must have a `.with_org(<expr>)` in its chain before being passed to `with_audit`/`with_audits` — flag `None`/absent.
2. The `.with_org` argument must be a **dynamic `current_org()`-derived expression**, not a hardcoded `OrgId::knl()` / `OrgId::from(<literal uuid>)`. A literal org binding on a tenant write is a violation unless carrying `// org-binding: ok <reason>` (the legit cold-start bootstrap path).
3. For public/no-JWT routers: forbid `scope_org(OrgId::knl())` literals; require `scope_org(resolved_org)` from a Host/subdomain/config resolver. This directly catches #19.21.

## 3. Prioritized fix plan (severity: core-flow-broken first)

### BATCH 1 — #19.13 Work-order create (P0, core intake flow, two independent sub-bugs)
**Fix A (cannot submit):** Normalize `management_no` consistently (strip `#` *and* `호기` suffix) on BOTH the create write-lookup and the import path so they match. Today REST `normalize_management_no` (workorder/rest:2749) strips `호기` but `create_work_order` (rest:2098) passes `body.management_no` raw, and the adapter normalizer (adapter:1358) strips only `#`. Apply the REST normalizer at create. Return a distinct 404 (`no equipment with that 호기`) the UI can render specifically.
**Fix B (invisible after submit):** Either ensure the receptionist's JWT `branches` claim includes `body.branch_id`, or relax the WO list for admin roles to org-wide. Recommended: treat receptionist/branch-admin filing as `BranchScope::All` for the list, or auto-include the filed branch.
**mnt_rt test** (extend `rls_read_surfaces_as_runtime_role.rs`, seed via the *armed* path not BYPASSRLS owner): (1) `import_master_list` row `management_no='3'`; `create_work_order` with `'3호기'` as armed mnt_rt → assert resolves+inserts (red before). (2) `create_work_order` in branch B; `list_work_orders` as admin whose `BranchScope::Branches` excludes B → assert `total==0` (proves hiding), then with B included → assert row appears.

### BATCH 2 — #19.21 Sales/rental inquiry (P0, customer-facing revenue, the one true RLS-value bug)
**Fix:** Stop hard-pinning `scope_org(OrgId::knl())` at sales/rest:201. Resolve storefront tenant from request (Host/subdomain → `organizations.slug`, or per-deploy `STOREFRONT_ORG_ID`); run public router under `scope_org(resolved_org)`. **Operational verification:** confirm the live KNL `organizations.id` is actually `0x…a1` and not a console-minted random uuid — if KNL was re-created via console, set `STOREFRONT_ORG_ID` to its real id. (Read-only diagnostic query only; no direct SQL mutation per ops policy.)
**mnt_rt test** (new `#[sqlx::test]` as NOBYPASSRLS mnt_rt — existing `sales_store.rs` runs one `scope_org(knl())` under BYPASSRLS and can never catch this): submit inquiry under `scope_org(knl())`; `list_inquiries` under `scope_org(other_org)` → assert empty (reproduces); after fix, submit+list under same resolved org → assert row returned.

### BATCH 3 — #19.17 Daily plan (P1, approval workflow blocked, no list endpoint exists)
**Fix:** Add RLS-armed branch-scoped `GET /api/daily-work-plans` → new `PgWorkOrderStore::list_daily_plans` running `SELECT … FROM daily_work_plans WHERE <branch_scope on branch_id> [AND plan_date=$date] ORDER BY plan_date DESC, created_at DESC` inside `with_org_conn(self.pool, current_org(), ..)` with **no status filter** (DRAFT/REQUESTED must appear). Wire `DailyPlanPage` to fetch+render this list, replacing the local-state/`?planId` deep-link model. **Do NOT** widen reporting `load_plan_rows` (reporting/adapter:917) — that status filter is intentional for the operational report; the approval queue needs its own list.
**mnt_rt test** (NOBYPASSRLS, same org but DIFFERENT user/admin in the plan's branch): create_daily_plan (DRAFT) → `list_daily_plans` asserts the DRAFT id is returned; `request_daily_plan_review` → assert still returned as REQUESTED. (Cannot even be written today — the missing method is the smoking gun.)

### BATCH 4 — #19.22 PM schedule (P1, pure UI date-window bug)
**Fix (UI only, not RLS):** After a successful create, snap/extend the visible range to include the new `due_date` (`rangeStart=min(rangeStart, due_date)`, `rangeEnd=max(rangeEnd, due_date+1)`) before `load()` (InspectionPage.tsx:86-87). Add a "전체/미완료(overdue)" toggle so backfilled past-due PM schedules are reachable. Backend filter (inspection/adapter:287-293) is correct.
**mnt_rt test** (NOBYPASSRLS like `region_branch_crud_rls_surfaces_as_runtime_role.rs`, NOT default BYPASSRLS `#[sqlx::test]`): as armed mnt_rt under `scope_org(knl)`, `create_schedule` with `due_date=today-90` and `today+60`; `list_due_schedules` with default `[today, today+30)` → assert `total==0` (reproduces); with corrected window → assert `total==1`.

### BATCH 5 — #19.18 Purchase request (P2, not invisibility — swallowed validation error)
**Fix (Class C, separate):** (1) Web: stop swallowing — read `response.error` and render the `KernelError` message at PurchaseRequestPanel.tsx:122; replace the raw evidence-id text field (line 262) with a picker listing only `VERIFIED` `REQUEST`-stage evidence for the chosen equipment. (2) Backend: reconsider the **synchronous** `worm_replica_status='VERIFIED'` precondition (financial/adapter:915) — allow create against `UPLOADED/UNVERIFIED` REQUEST evidence and defer the WORM check to submit/execute, OR surface "거래명세표 still verifying" to the operator.
**mnt_rt test** (new in `financial/adapter-postgres/tests/lifecycle_rls_surfaces_as_runtime_role.rs`): (a) seed REQUEST evidence `worm_replica_status='UNVERIFIED'` → assert `create_purchase_request` returns validation error (proves real-world failure — `use_cases.rs:715` only ever seeds VERIFIED, which masked it); (b) seed VERIFIED → assert create succeeds AND `purchase_by_id` surfaces the row as armed mnt_rt.

## 4. Non-RLS breakages flagged (4 of 5 are not RLS at all)

- **#19.13** — NOT RLS. (a) management-no normalization mismatch → not_found 404; (b) JWT branch-scope filter hides the row. Fix = normalization + branch-scope, above.
- **#19.17** — NOT RLS. Missing list endpoint + reporting status filter (`APPROVED/FINAL_CONFIRMED`) excludes DRAFT. Fix = new list endpoint, above.
- **#19.18** — NOT RLS. Synchronous WORM-VERIFIED precondition 4xx + web `catch{}` discards error body. Fix = surface error + relax/picker, above.
- **#19.22** — NOT RLS. UI date window `[today, today+30)` excludes the chosen `due_date`. Fix = UI range snap, above.
- **#19.21** — the *only* one where RLS participates, but as a **wrong-org-value (sentinel) bug**, not a missing-arm bug. Fix = resolve storefront org dynamically, above.

**Net:** there is no systemic missing-`.with_org`. The systemic *pattern* is **over-narrow admin read surfaces** (Batch B: branch-scope / no-list-endpoint / date-window) plus one **hardcoded-org public-submit** (#19.21) and one **swallowed-validation** (#19.18). Fix order by severity: **1 → 2 → 3 → 4 → 5**. Close the gate hole (Section 2) so the hardcoded-org / armed-with-None class can't regress.