# Finance voucher and GL domain model — B21a implementation contract

Task: `t_87ff0fae`
GitHub issue: `#317` — `[backend-gap/B21a] Module domain — finance vouchers (VC-/GL)`
Status: implementation-ready design/spec; no database migrations or Rust code are implemented by this note.

## 0. Source context and constraints

Primary inputs read for this spec:

- `gh issue view 317`: finance VC-/GL has no backend model yet; every mutation must use `with_audit`; org scope must come from the principal via `with_org_conn` / `with_audit`; RLS tests must run as `mnt_rt`; OpenAPI edits require regenerating all three clients.
- `.omc/plans/carbon-copy-charter.md`: P3 modules are thin domain bindings on BE-OBJ and BE-LC; no fake data, no decorative lifecycle ribbons.
- `.omc/research/oyatie/prototype-anatomy/04-backend-contract.md`: Gap Register #21 names finance VC-/GL, inventory, and compliance as module-domain gaps; existing rental quotes/cost ledger/purchase APIs are not a voucher/general-ledger model.
- `.omc/research/oyatie/finance-module-config-mapping.md`: the current console contract expects `objectKind: "finance_voucher"`, `codePrefix: "VC-"`, and `/api/v1/finance/vouchers` create/read/post routes.
- `web/src/console/modules/moduleScreens.ts`: the current finance module placeholder is backend-blocked and must not synthesize VC rows.
- `backend/crates/financial/{domain,application,adapter-postgres,rest}`: existing clean-architecture crates already own rental quote, cost ledger, and purchase flows.
- `backend/crates/platform/db/src/audit_tx.rs`: `with_audit`, `with_audits`, and `with_org_conn` bind `app.current_org` before reads/writes and append audit rows atomically.
- `origin/main:backend/app/src/objects.rs`: BE-OBJ owns `/api/objects/{kind}/{id}`, `/api/objects/{kind}/{id}/graph`, `/api/v1/object-links`, `/api/v1/object-types`, and denies by omission for unresolvable or unauthorized graph nodes.
- `origin/main:backend/app/src/lifecycle.rs` and `origin/main:backend/crates/platform/db/src/lifecycle.rs`: BE-LC owns `/api/v1/lifecycles/{objectType}/{objectId}`, transition/hold endpoints, append-only lifecycle transitions, legal-hold/retention gates, and transition rules.
- `origin/main:backend/crates/platform/db/migrations/0102_create_object_types_and_links.sql`: `object_links` is org-scoped, FORCE-RLS tenant data; `object_types` is global seeded reference data.
- `origin/main:backend/crates/platform/db/migrations/0107_create_period_locks_versioning_lifecycle.sql`: period locks support `domain in ('payroll', 'accounting')`; generic versioning pattern is append-only versions + rollback-as-new-version; lifecycle rules are global reference rows.

Important checkout note: the active `feat/cedar-activation` worktree is stale versus `origin/main` for BE-OBJ/BE-LC files. Implementation should rebase/branch from a head that contains `backend/app/src/objects.rs`, `backend/app/src/lifecycle.rs`, `backend/crates/platform/db/src/lifecycle.rs`, and migrations 0102/0107+ before coding B21a. This design uses the substrate as present on `origin/main`.

## 1. Decisions

1. Reuse the existing financial clean-architecture crates instead of adding a new top-level domain:
   - `backend/crates/financial/domain/src/voucher.rs`
   - `backend/crates/financial/domain/src/gl_account.rs`
   - `backend/crates/financial/application/src/voucher.rs`
   - `backend/crates/financial/adapter-postgres/src/voucher.rs`
   - `backend/crates/financial/rest/src/voucher.rs`
   - public re-exports from the existing `lib.rs` files.

2. Canonical object kinds for this feature are:
   - `finance_voucher` for VC- vouchers;
   - `gl_account` for GL account heads.

   Rationale: current console config, policy strings, lifecycle path, and stat sources already use `finance_voucher`. `origin/main` has a broad seeded `voucher` kind, but B21a should not bind the finance console to that ambiguous kind unless the frontend config, object registry, lifecycle rules, audit target types, and OpenAPI contract are changed in the same PR. Preferred path: add explicit `finance_voucher` and `gl_account` rows to `object_types` and add resolver arms for both. Leave the generic `voucher` seed untouched or migrate it later via an explicit alias/deprecation decision.

3. Preferred REST routes are the routes already declared by the console mapping:
   - `GET /api/v1/finance/vouchers`
   - `POST /api/v1/finance/vouchers`
   - `GET /api/v1/finance/vouchers/{voucherId}`
   - `POST /api/v1/finance/vouchers/{voucherId}/post`
   - `GET /api/v1/finance/gl-accounts`
   - `GET /api/v1/finance/gl-accounts/{accountId}`

   Existing `/api/v1/financial/*` routes remain rental quote / equipment cost ledger / purchase-request surfaces. Do not expose duplicate `/financial/vouchers` aliases unless the team intentionally updates the console contract and OpenAPI in the same change.

4. `finance_voucher` lifecycle state and accounting posting status are separate:
   - lifecycle state describes object governance: `draft`, `review`, `active`, `archived`, `disposed`;
   - posting status describes ledger effect: `unposted`, `posted`, `reversed`.

   The post command transitions lifecycle to `active` and posting status to `posted` atomically. The UI may render a posted chip from `postingStatus=posted`; it should not require lifecycle state literally named `posted`.

5. GL account linkage is line-level domain data, not merely graph metadata. `object_links` may expose graph/source chips, but voucher balance and posting invariants must be enforced from `financial_voucher_lines.gl_account_id` foreign keys to `financial_gl_accounts`.

## 2. Crate/module contract

### 2.1 Kernel identifiers

Add typed IDs to `mnt-kernel-core` if the implementation follows the existing `QuoteId` / `PurchaseRequestId` pattern:

- `FinanceVoucherId(Uuid)`
- `GlAccountId(Uuid)`
- optionally `FinanceVoucherLineId(Uuid)` for API-facing line references.

If a smaller first PR keeps line IDs as raw `uuid::Uuid`, keep voucher/account IDs typed. Do not pass user-supplied string IDs through domain/application boundaries.

### 2.2 `mnt-financial-domain`

Suggested modules:

- `voucher.rs`: pure voucher states, line balancing, posting validation, source-ref validation, version policy.
- `gl_account.rs`: GL account value objects and status/normal-balance validation.

Suggested core types:

- `FinanceVoucher`
  - `id: FinanceVoucherId`
  - `code: VoucherCode` (`VC-...`, backend-issued, immutable)
  - `org_id: OrgId`
  - `branch_id: Option<BranchId>`
  - `title: String`
  - `memo: Option<String>`
  - `voucher_date: Date`
  - `period: AccountingPeriod` (`YYYY-MM` or explicit start/end; pick one and keep DTO stable)
  - `lifecycle_state: VoucherLifecycleState`
  - `posting_status: VoucherPostingStatus`
  - `current_version: i32`
  - `posted_version: Option<i32>`
  - `total_debit_won: i64`
  - `total_credit_won: i64`
  - `validation_status: VoucherValidationStatus`
  - `created_by`, `created_at`, `updated_at`, `posted_by`, `posted_at`

- `GlAccount`
  - `id: GlAccountId`
  - `org_id: OrgId`
  - `code: GlAccountCode` (tenant-scoped, not a VC code)
  - `name: String`
  - `account_type: GlAccountType` (`asset`, `liability`, `equity`, `revenue`, `expense`)
  - `normal_balance: NormalBalance` (`debit`, `credit`)
  - `status: GlAccountStatus` (`active`, `archived`)
  - optional `parent_id: Option<GlAccountId>` for future account hierarchy.

- `FinanceVoucherLine`
  - `id: FinanceVoucherLineId` or `Uuid`
  - `line_no: i32`
  - `gl_account_id: GlAccountId`
  - `gl_account_code: GlAccountCode` in read models only
  - `description: Option<String>`
  - `debit_won: i64`
  - `credit_won: i64`
  - optional `cost_center_kind/id` later; do not invent now.

- `VoucherSourceRef`
  - `kind: VoucherSourceKind` (`dx_ingest`, `approval_run`, `payroll_run`, `purchase_request`, `contract`, `cost_ledger`, `manual`)
  - `id: String` (object registry ID form; use UUID when the source kind is UUID-backed)
  - `code: Option<String>` for display only
  - `link_type: VoucherLinkType` (`source_of`, `authorized_by`, `settles`, `supports`, `posts_to`).

- enums:
  - `VoucherLifecycleState`: `Draft`, `Review`, `Active`, `Archived`, `Disposed`.
  - `VoucherPostingStatus`: `Unposted`, `Posted`, `Reversed`.
  - `VoucherValidationStatus`: `Valid`, `Unbalanced`, `InvalidGlAccount`, `SourceMissing`, `PeriodLocked`.

Domain functions/invariants:

- `validate_voucher_draft(input) -> Result<ValidatedVoucherDraft, KernelError>`
  - title non-blank;
  - voucher date present;
  - at least two lines;
  - every line has exactly one positive side (`debit_won > 0 xor credit_won > 0`);
  - no negative values;
  - sum debit == sum credit;
  - balanced total > 0;
  - no duplicate `line_no`;
  - all line account IDs are supplied.

- `validate_gl_linkage(lines, account_lookup) -> Result<(), KernelError>`
  - every referenced account exists in the caller's org under RLS;
  - every account is `active`;
  - archived/inactive/cross-org accounts return the same application-level `invalid_gl_account` outcome; do not leak whether a denied ID exists elsewhere;
  - account type/normal balance is advisory for display, not a reason to reject a balanced manual journal unless future policy explicitly forbids it.

- `validate_post_transition(voucher, expected_version, today, period_lock_status) -> Result<(), KernelError>`
  - lifecycle state is `draft` or `review`;
  - posting status is `unposted`;
  - `expected_version == current_version` if supplied;
  - validation status is `valid`;
  - accounting period is open;
  - legal hold/disposed lifecycle gates are not violated;
  - posted vouchers cannot be edited in place.

### 2.3 `mnt-financial-application`

Commands:

- `CreateFinanceVoucherCommand`
  - `actor: UserId`
  - `branch_id: Option<BranchId>` (request-selected branch must be checked against `principal.branch_scope`; org still comes from principal/current request context)
  - `title`, `memo`, `voucher_date`, `period`
  - `lines: Vec<CreateFinanceVoucherLineInput>`
  - `source_refs: Vec<VoucherSourceRefInput>`
  - `idempotency_key: Option<String>` if the UI may retry create; if omitted, document non-idempotent behavior
  - `trace: TraceContext`
  - `occurred_at: Timestamp`

- `PostFinanceVoucherCommand`
  - `actor: UserId`
  - `voucher_id: FinanceVoucherId`
  - `expected_version: Option<i32>`
  - `reason: String`
  - `trace`, `occurred_at`

- optional read queries:
  - `ListFinanceVouchersQuery { branch_scope, status, posting_status, period, source_kind, limit, cursor }`
  - `ListGlAccountsQuery { status, q, limit }`.

DTO/read models:

- `FinanceVoucherListItem`
  - `id`, `code`, `title`, `lifecycle_phase`, `posting_status`, `period`, `voucher_date`, `posted_at`
  - `total_debit_won`, `total_credit_won`
  - `source_kind`, `source_code`
  - `gl_account_summary`
  - `validation_status`
  - `linked_object_codes`

- `FinanceVoucherDetail`
  - all list fields plus `memo`, `branch_id`, `org_id`, `current_version`, `posted_version`, `lines`, `source_refs`, `audit_trace_id`.

- `FinanceVoucherLineDto`
  - `id`, `line_no`, `gl_account: GlAccountDto`, `description`, `debit_won`, `credit_won`.

- `GlAccountDto`
  - `id`, `code`, `name`, `account_type`, `normal_balance`, `status`.

- request DTOs stay in REST, but application command structs should be serializable for test fixtures.

Audit-event builders:

- Add `finance_voucher_audit_event(action, actor, branch_id, target_id, trace, occurred_at)` or extend the existing `financial_audit_event` helper.
- Required successful mutation actions:
  - `finance_voucher.create`
  - `finance_voucher.version_capture`
  - `finance_voucher.post`
  - `finance_voucher.lifecycle_init` if lifecycle materialization is not covered by the create snapshot
  - future account-management actions: `gl_account.create`, `gl_account.update`, `gl_account.archive`.
- `target_type` must be `finance_voucher` for voucher mutations and `gl_account` for GL account changes.
- `target_id` must be the UUID string, not the display code.
- Include `org_id` via `.with_org(org)` so `with_audit` arms RLS.
- Include `branch_id` via `.with_branch(branch)` when the voucher is branch-scoped.
- Include before/after snapshots for post (`posting_status`, lifecycle state, version, totals, account IDs, period); do not include secrets or raw sensitive PII.

### 2.4 `mnt-financial-adapter-postgres`

Store methods:

- `list_finance_vouchers(query) -> FinanceVoucherPage`
- `get_finance_voucher(id) -> Option<FinanceVoucherDetail>`
- `list_gl_accounts(query) -> Vec<GlAccountDto>`
- `get_gl_account(id) -> Option<GlAccountDto>`
- `create_finance_voucher(command) -> FinanceVoucherDetail`
- `post_finance_voucher(command) -> FinanceVoucherDetail`

Read path requirements:

- Use `current_org()` and `with_org_conn(&pool, org, ...)` for every read.
- Branch filtering must be explicit in SQL using `principal.branch_scope` / `repository_filter` style; RLS only protects org, not branch.
- Direct `get` returns not found for outside-org/outside-branch rows; do not return a distinct authorization error for a concrete voucher ID because that becomes an existence oracle.

Mutation path requirements:

- Use `current_org()` and `with_audit` or `with_audits` for every mutation.
- The transaction closure must:
  1. lock the voucher row on post with `SELECT ... FOR UPDATE`;
  2. validate current version/status;
  3. validate all GL accounts under the same RLS-armed transaction;
  4. call the period-lock guard for `accounting` and the voucher period/date;
  5. update voucher posting fields;
  6. capture append-only version rows as needed;
  7. create/update the lifecycle row/transition inside the same transaction;
  8. insert `object_links` for source/account graph chips only after endpoint resolvability checks pass, or else skip graph links and expose linkage through the voucher detail until BE-OBJ resolvers are added.

Persistence shape for a later migration:

- `financial_gl_accounts`
  - `id uuid primary key default gen_random_uuid()`
  - `org_id uuid not null references organizations(id)`
  - `code text not null`
  - `name text not null`
  - `account_type text not null check (...)`
  - `normal_balance text not null check (...)`
  - `status text not null check (status in ('active','archived'))`
  - `parent_id uuid null`
  - `created_at`, `updated_at`
  - `unique(org_id, code)`
  - FORCE RLS by `app.current_org`

- `financial_vouchers`
  - `id`, `org_id`, `branch_id`, `code`, `title`, `memo`, `voucher_date`, `period_start`, `period_end`
  - `lifecycle_state` may be a denormalized read cache only; the authoritative lifecycle remains `object_lifecycles`
  - `posting_status`, `posted_at`, `posted_by`
  - `current_version`, `posted_version`
  - `total_debit_won`, `total_credit_won`, `validation_status`
  - `created_by`, `created_at`, `updated_at`
  - `unique(org_id, code)`
  - FORCE RLS by `app.current_org`

- `financial_voucher_lines`
  - `id`, `org_id`, `voucher_id`, `line_no`, `gl_account_id`, `description`, `debit_won`, `credit_won`
  - `unique(org_id, voucher_id, line_no)`
  - FK `(voucher_id, org_id)` to vouchers and `(gl_account_id, org_id)` to GL accounts
  - FORCE RLS by `app.current_org`

- `financial_voucher_versions`
  - append-only version table modeled after `registry_equipment_versions`
  - `id`, `org_id`, `object_id`, `version`, `status`, `source_version`, `content jsonb`, `created_by`, `created_at`
  - `unique(org_id, object_id, version)`
  - no update/delete triggers via `platform_append_only_immutable()`
  - FORCE RLS by `app.current_org`

- Optional `financial_voucher_idempotency_keys`
  - only if create retries are expected before the first implementation PR lands.

Do not store cross-object source refs in a bespoke table unless the voucher needs source-specific metadata that `object_links` cannot represent. Preferred graph contract: `object_links` rows with `src_kind='finance_voucher'`, `src_id=<voucher uuid>`, `dst_kind=<source kind>`, `dst_id=<source id>`, `link_type in ('source_of','authorized_by','settles','supports','posts_to')`.

### 2.5 `mnt-financial-rest`

Routes and authorization:

- `GET /api/v1/finance/vouchers`
  - feature: `finance_voucher_read`
  - returns `FinanceVoucherPage`
  - filters are deny-by-omission; caller sees only org + authorized branch rows.

- `GET /api/v1/finance/vouchers/{voucherId}`
  - feature: `finance_voucher_read`
  - returns `FinanceVoucherDetail`
  - outside scope is `404`/not found.

- `POST /api/v1/finance/vouchers`
  - feature: `finance_voucher_create`
  - request body:
    - `branchId?: uuid`
    - `title: string`
    - `memo?: string`
    - `voucherDate: YYYY-MM-DD`
    - `period?: { start: YYYY-MM-DD, end: YYYY-MM-DD }` or `period: YYYY-MM`; choose one before OpenAPI
    - `lines: [{ glAccountId, description?, debitWon?, creditWon? }]`
    - `sourceRefs?: [{ kind, id, code?, linkType? }]`
    - `idempotencyKey?: string`
  - response: `201 FinanceVoucherDetail`.

- `POST /api/v1/finance/vouchers/{voucherId}/post`
  - feature: `finance_voucher_post`
  - request body:
    - `expectedVersion?: number`
    - `reason: string`
  - response: `200 FinanceVoucherDetail`.

- `GET /api/v1/finance/gl-accounts`
  - feature: `finance_voucher_read` or `gl_account_read` (preferred explicit `gl_account_read` if feature catalog is extended)
  - returns active accounts by default; include `status=all` only for managers.

- `GET /api/v1/finance/gl-accounts/{accountId}`
  - same read feature; outside scope is not found.

Feature/catalog additions:

- `finance_voucher_read`
- `finance_voucher_create`
- `finance_voucher_post`
- `gl_account_read`
- optional future `gl_account_manage`

Initial legacy matrix recommendation until Cedar/PBAC custom grants own it:

- read: `ADMIN`, `EXECUTIVE`, `SUPER_ADMIN`
- create: `ADMIN`, `SUPER_ADMIN`
- post: `EXECUTIVE`, `SUPER_ADMIN` or a tenant-granted custom finance-post capability
- GL account manage: `SUPER_ADMIN` only until a policy-studio role exists

Do not reuse `purchase_request_*`, `equipment_cost_ledger_*`, or `rental_quote_manage` to authorize voucher posting.

## 3. Object/lifecycle integration points

### 3.1 Object registry and graph

Required BE-OBJ additions:

- Insert `object_types` rows:
  - `finance_voucher`, code prefix `VC-`, description `Financial voucher / GL posting`.
  - `gl_account`, code prefix nullable or `GL`, description `General ledger account`.

- Add `RESOLVABLE_KIND_AUTH` entries in `backend/app/src/objects.rs`:
  - `finance_voucher -> RequiredAuth::Feature(Feature::FinanceVoucherRead)`
  - `gl_account -> RequiredAuth::Feature(Feature::FinanceVoucherRead)` or `Feature::GlAccountRead`.

- Add `resolve_head` arms:
  - `resolve_finance_voucher`: query `financial_vouchers`, branch-filter, return `code`, `title`, and a status derived from lifecycle/posting (`posted` if posting_status posted, else lifecycle state).
  - `resolve_gl_account`: query `financial_gl_accounts`, return `code`, `name`, `status`; no branch filter unless accounts become branch-specific.

- Add object graph tests:
  - finance voucher resolves for authorized finance principal;
  - unauthorized member gets 403 for direct kind or omission in graph;
  - cross-org voucher is omitted under RLS;
  - voucher linked to GL account/source objects appears with bounded graph edges.

Link types to register or reuse:

- `source_of` for source object -> voucher or voucher -> source; choose direction and document it. Preferred: `finance_voucher -> source` with `link_type='source_of'` to match finance module detail chips.
- `authorized_by` for approval run/source AP.
- `posts_to` for voucher -> GL account graph chips.
- `supports` for evidence/cost-ledger references.

### 3.2 Lifecycle rules

Add `lifecycle_transition_rules` for `finance_voucher`:

- `draft -> review`
- `review -> draft`
- `draft -> active`
- `review -> active`
- `active -> archived`
- `archived -> disposed`

The `post_finance_voucher` command is the only route in B21a that transitions a voucher to `active`; it also sets `posting_status='posted'`. Generic lifecycle transition REST should not be allowed to bypass GL validation/posting for the `draft/review -> active` transition. Enforce this either by:

1. adding a domain-owned `post` route as the only advertised transition path for finance vouchers, and documenting generic lifecycle manage as admin/internal only; or
2. adding a lifecycle precondition hook before generic lifecycle transitions can activate finance vouchers.

Option 1 is the smaller B21a path.

Lifecycle materialization on create:

- Create the `object_lifecycles` row at `draft` inside the same `with_audits` transaction as voucher insert/version capture.
- If the existing lifecycle helper does not expose an `ensure_lifecycle` function, add one to `mnt_platform_db::lifecycle` rather than inserting lifecycle rows ad hoc in the financial adapter.
- Create/post audits must target `finance_voucher`; the lifecycle transition log remains append-only in `object_lifecycle_transitions`.

### 3.3 Versioning

Draft/review changes are versioned; posted accounting facts are immutable.

- On create, insert `financial_voucher_versions(version=1, status='CAPTURED', content=<header+lines+source refs>)` and set `current_version=1`.
- Any future edit before posting inserts version N+1 and updates `current_version`; no in-place line mutation without version capture.
- On post, set `posted_version=current_version`. If a post command normalizes derived fields, capture the posted snapshot as `status='POSTED'` in the version table or include the posted fields in the audit after-snapshot.
- After posting, no update route may modify voucher header/lines. Corrections are compensating reversal/new vouchers with `object_links` and audit, not destructive rollback.
- `financial_voucher_versions` is append-only and FORCE-RLS.

### 3.4 Period locks

Posting must check accounting period locks before mutating:

- use `PeriodLockDomain::Accounting` or equivalent;
- derive the checked period from `voucher_date` / accounting period stored on the voucher;
- return conflict when the period is locked;
- never allow a posted_at date or effective accounting date inside a locked period.

## 4. RLS, tenant, and branch isolation

- Every table with `org_id` must enable and FORCE RLS using `app.current_org`.
- `object_types` / lifecycle rules remain global reference data and must be tenant-isolation allowlisted.
- Reads use `with_org_conn(pool, principal.org_id, ...)`.
- Mutations use `with_audit` / `with_audits` with `.with_org(principal.org_id)` before the closure runs.
- Request bodies never include `org_id`.
- `branch_id` may be selected by the user only if it is inside `principal.branch_scope`; otherwise return not found/forbidden without revealing cross-branch rows.
- Direct object IDs outside org/branch resolve as not found, matching BE-OBJ deny-by-omission behavior.
- Tests must use `mnt_rt` and the dev database port from the issue (`127.0.0.1:55432`) when live DB is needed; `SQLX_OFFLINE=true` is only compile-time query checking, not runtime RLS proof.

## 5. Edge cases and expected behavior

| Case | Expected behavior |
|---|---|
| create with zero/one line | 422 validation error; no row, no audit event |
| line has both debit and credit | 422 validation error |
| negative debit/credit | 422 validation error |
| debit total != credit total | 422 `unbalanced`; no voucher post |
| GL account ID does not exist, is inactive, archived, cross-org, or not visible | 422/404 mapped to `invalid_gl_account`; do not reveal which condition applied |
| source ref kind is unknown | 422 validation error before object link insert |
| source ref exists in another org or is not visible | omit/deny the link; create should fail if source is required, or create without optional link only if body marks it optional |
| create retried after client timeout | if `idempotencyKey` is implemented, return existing voucher for same actor/key/org; otherwise document non-idempotent create |
| post already-posted voucher | 409 conflict |
| post with stale expected version | 409 conflict |
| post while accounting period is locked | 409 conflict with `period_locked`; no lifecycle transition |
| post from lifecycle `archived`/`disposed` | 409 invalid transition |
| generic lifecycle transition tries to activate unposted voucher | must be blocked; only domain post route can active/post finance vouchers |
| branch outside caller scope | deny by omission on reads; mutation rejected before insert |
| object graph includes unauthorized linked source | unauthorized node/edge omitted, not shown as dead chip |
| code generation collision | retry bounded number of times in transaction or rely on sequence; client never supplies `VC-` code |
| posted voucher needs correction | create reversal/new voucher; link with `reverses`/`corrects`; no in-place posted mutation |

## 6. OpenAPI/client boundary

When implementation starts:

1. Add schemas for:
   - `FinanceVoucherListItem`
   - `FinanceVoucherDetail`
   - `FinanceVoucherLine`
   - `GlAccount`
   - `CreateFinanceVoucherRequest`
   - `CreateFinanceVoucherLineInput`
   - `VoucherSourceRefInput`
   - `PostFinanceVoucherRequest`
   - `FinanceVoucherPage`
   - enum schemas for lifecycle/posting/validation/account statuses.
2. Add paths listed in section 2.5.
3. Run `npm run gen:api` and verify TS, Kotlin, and Swift generated clients are updated. The issue explicitly calls out Swift as the recurring miss.
4. Update `web/src/console/modules/moduleScreens.ts` only if the route/object-kind decision changes. Preferred: keep existing `/api/v1/finance/vouchers` + `finance_voucher` mapping.

## 7. Test and gate plan for implementation children

Minimum tests before B21a is merge-ready:

- Domain unit tests:
  - balanced vs unbalanced vouchers;
  - invalid GL account status;
  - post transition version/status invariants;
  - no in-place edit after posting.

- Adapter SQLx tests as `mnt_rt`:
  - org A cannot list/read/post org B voucher;
  - branch-scoped principal sees only scoped branches;
  - create writes voucher, lines, version row, lifecycle row, and audit event in one transaction;
  - post writes posting fields, lifecycle transition, version/audit evidence in one transaction;
  - failure paths roll back all rows and audit events;
  - inactive/cross-org GL account rejects posting without leaking existence;
  - period lock rejects post.

- REST tests:
  - unauthorized user has no finance voucher routes/actions;
  - list/detail/create/post happy path;
  - not-found/deny-by-omission behavior;
  - invalid request bodies map to stable 4xx errors.

- BE-OBJ/BE-LC tests:
  - `GET /api/objects/finance_voucher/{id}` resolves after create;
  - graph includes visible GL/source links and omits unauthorized links;
  - `/api/v1/lifecycles/finance_voucher/{id}` returns draft/active and append-only transition history.

- Gates from the issue:
  - `cargo run -p mnt-gate-tenant-isolation --offline`
  - `cargo run -p mnt-gate-rls-arming --offline`
  - `cargo run -p mnt-gate-audit-coverage --offline`
  - `cargo run -p mnt-gate-migration-safety --offline`
  - `cargo run -p mnt-gate-layer-boundary --offline`

- OpenAPI/client drift after route/schema changes:
  - `npm run gen:api`
  - relevant drift checks for TS/Kotlin/Swift clients.

## 8. Non-goals for B21a

- No Excel/import-first voucher workflow.
- No fake `VC-` rows from purchase requests, rental quotes, cost ledger entries, or AP approvals.
- No payroll-run or DX-ingest backend implementation; those remain separate gaps and can be optional source refs only when real objects exist.
- No GL account management UI beyond read/list unless a follow-up explicitly owns account CRUD and policy.
- No destructive rollback of posted vouchers.
- No database migrations in this design task; migration numbering must be chosen just before implementation/merge because concurrent sessions collide.

## 9. Handoff to implementation children

Suggested child split:

1. Persistence/RLS/audit/lifecycle child (`t_ea1967f5`): implement IDs, tables/migrations, domain/application/store methods, lifecycle rules, object type rows, audit events, and mnt_rt/gate tests.
2. REST/OpenAPI child (`t_a7144e61`): expose routes, schemas, authorization, OpenAPI, client generation, and REST tests once persistence contract is settled.
3. UI consumer child (#332 or finance-module lane): switch from backend-blocked shell to live data only after B21a routes, generated clients, object resolve, lifecycle, and graph evidence are real.

Downstream implementers should treat this note as the canonical B21a backend contract unless a later review/fix card supersedes it with an explicit Kanban comment.
