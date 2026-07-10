# Finance module config mapping — VC-/GL generic console surface

Task: `t_da906c20` — implementation-ready mapping for `t_3e30583b`.

## Source verdict

- `docs/design/oyatie-console/Oyatie Console.dc.html` contains no `MOD_SCREENS`, `finance`, `VC-`, `전표`, or `원장` hits in the current mirror. This matches `.omc/research/oyatie/prototype-anatomy/02-screens/post-snapshot-screens.md:1-3`: the module screens are post-snapshot and the AGENTS changelog + DESIGN grammar are the spec.
- Carbon-copy route strategy is `/console` with internal `state.screen`, not legacy AppShell pages: `.omc/plans/carbon-copy-charter.md:40-44`.
- P0 module grammar is one config-driven section: compact statbar + search + primary action, shared-track list, detail kv + links + actions: `.omc/plans/carbon-copy-charter.md:125-127`, `.omc/research/oyatie/prototype-anatomy/03-systems.md:58-63`, `docs/design/oyatie-console/AGENTS.md:53-55`.
- Finance module identity: `finance` / `재무`, object prefix `VC-`, vouchers/general-ledger, linked to wf6 open-banking ingest, payroll, and AP approvals: `.omc/research/oyatie/prototype-anatomy/02-screens/post-snapshot-screens.md:89-96`, `docs/design/oyatie-console/ROADMAP.md:68-79`, `docs/design/oyatie-console/ROADMAP.md:92-95`.
- Backend status: finance VC-/GL is backend gap B21a. Existing rental quote/cost-ledger/purchase APIs are real, but they are not a VC-/GL domain and must not be relabeled as vouchers: `.omc/research/oyatie/prototype-anatomy/04-backend-contract.md:192-207`, gap register `.omc/research/oyatie/prototype-anatomy/04-backend-contract.md:241-255`, GitHub #317 `[backend-gap/B21a] Module domain — finance vouchers (VC-/GL)`.

## Target route/component registration

Implementation target is console-only; do not import legacy `web/src/pages/FinancialPage.tsx` or `web/src/features/financial/**` JSX into `web/src/console/**`.

Expected registration shape:

- route surface: `/console`, internal screen key `finance`
- nav group: ERP / `재무`
- config id: `finance`
- object kind: `finance_voucher`
- object code prefix: `VC-`
- object type card: finance voucher / general ledger voucher, eventually `OT-*` once type-card lifecycle is wired
- primary files if the generic substrate exists:
  - `web/src/console/modules/moduleScreens.ts` or equivalent registry: add `financeModuleScreen`
  - `web/src/console/modules/GenericModuleScreen.tsx` or equivalent generic renderer: no finance-only duplicated shapes
  - `web/src/console/modules/FinanceModuleScreen.tsx`: optional thin wrapper only, passing config
  - `web/src/i18n/ko.ts`: add `ko.console.modules.finance.*`
- if the generic module substrate is still absent in this checkout, create it once under `web/src/console/modules/**` and make finance the first config; do not build a bespoke finance card/list template.

## Intended MOD_SCREENS-style config

Names below are implementation-ready keys; adjust only to match the actual generic substrate names.

```ts
const financeModuleScreen = {
  id: "finance",
  screen: "finance",
  route: "/console",              // state.screen="finance"
  navLabelKey: "console.modules.finance.nav",
  titleKey: "console.modules.finance.title",
  objectKind: "finance_voucher",
  codePrefix: "VC",
  detailPanelDefault: "pin-right",
  emptyMode: "blocked-until-backend", // no fake rows/codes while B21a is absent

  policy: {
    read: "finance_voucher_read",
    create: "finance_voucher_create",
    post: "finance_voucher_post",
    link: "object.link.create",
    graph: "object.view",
    audit: "audit_log_read"
  },

  data: {
    listEndpoint: "/api/v1/finance/vouchers",
    detailEndpoint: "/api/v1/finance/vouchers/{voucherId}",
    createEndpoint: "/api/v1/finance/vouchers",
    postEndpoint: "/api/v1/finance/vouchers/{voucherId}/post",
    lifecycleEndpoint: "/api/v1/lifecycles/finance_voucher/{voucherId}",
    objectResolve: "/api/objects/{kind}/{id}",
    graphEndpoint: "/api/objects/{kind}/{id}/graph",
    linksEndpoint: "/api/v1/object-links"
  },

  statbar: [
    { key: "review", source: "vouchers[phase in draft|review]", tone: "warn" },
    { key: "posted", source: "vouchers[posting_status=posted,current_period]", tone: "ok" },
    { key: "linked", source: "object_links where source=VC and target in DX|AP|PS|PayrollRun", tone: "info" },
    { key: "exceptions", source: "voucher validation: unbalanced|invalid_gl_account|source_missing", tone: "danger" }
  ],

  search: {
    mode: "multi-attribute",
    fields: [
      "code", "title", "memo", "status", "posting_status", "period",
      "source_code", "source_kind", "gl_account_code", "gl_account_name",
      "amount_won", "counterparty", "actor_name", "linked_object_codes"
    ]
  },

  list: {
    keyboard: ["J", "K", "Enter"],
    sharedTrack: "financeVoucherTrack",
    columns: [
      { key: "code", labelKey: "console.modules.finance.columns.code", mono: true },
      { key: "status", labelKey: "console.modules.finance.columns.status", chip: true },
      { key: "source", labelKey: "console.modules.finance.columns.source", chip: true },
      { key: "title", labelKey: "console.modules.finance.columns.title" },
      { key: "amount", labelKey: "console.modules.finance.columns.amount", align: "end" },
      { key: "gl", labelKey: "console.modules.finance.columns.gl" },
      { key: "links", labelKey: "console.modules.finance.columns.links", linkChips: true },
      { key: "postedAt", labelKey: "console.modules.finance.columns.postedAt" }
    ]
  },

  detail: {
    kv: [
      "code", "title", "lifecyclePhase", "lifecycleVersion", "postingStatus",
      "period", "voucherDate", "postedAt", "totalDebitWon", "totalCreditWon",
      "sourceKind", "sourceCode", "glAccountSummary", "orgScope", "branchScope",
      "createdBy", "auditTraceId"
    ],
    linkChips: [
      "lifecycle", "objectGraph", "auditTrail", "sourceDx", "sourceAp",
      "sourcePayroll", "sourcePurchase", "sourceContract", "glAccount", "costLedger"
    ],
    actions: ["openSource", "openGraph", "openLifecycle", "postVoucher", "createRelation"]
  },

  primaryAction: {
    key: "createVoucher",
    labelKey: "console.modules.finance.actions.createVoucher",
    policyAction: "finance_voucher_create",
    blockedUntil: "B21a finance VC-/GL backend"
  }
};
```

## P0 generic surface mapping

| Surface | Finance binding | Implementation note |
|---|---|---|
| compact statbar | 4 chips: 검토 대기, 전기 완료, 원천 연결, 예외 | All four require B21a list/validation data. Until then render no numeric stats or render `—`/blocked chip only; never invent counts. |
| multi-attribute search | code/title/memo/status/period/source code/GL account/amount/counterparty/actor/linked code | Requires B21a list rows or global object search. Without rows, search control may be omitted by policy/data availability. |
| shared-track list | one `financeVoucherTrack` grid reused by every row | Columns above; J/K/Enter opens pinned detail. No per-row layout variants. |
| kv/detail area | voucher header + posting/lifecycle + balanced totals + source + GL + audit | Detail opens in right-pinned panel by default, matching the window model. |
| link chips | lifecycle, object graph, audit, DX, AP, payroll/PS, purchase/PO, contract/C, GL account, equipment cost ledger | Chips only appear when the backing object ID/code exists and policy allows the target. No dead chip. |
| domain primary action | `전표 생성` for draft create; row action `전기` for post-ready vouchers | Both hidden until `finance_voucher_create` / `finance_voucher_post` are backed by B21a and policy grants. |

## Object sources per stat/row/link

| Config key | Object/source | Status now | Notes |
|---|---|---|---|
| `statbar.review` | VC vouchers in draft/review lifecycle | BLOCKED by B21a | Needs voucher table/read model + lifecycle phase. |
| `statbar.posted` | posted VC vouchers for current period | BLOCKED by B21a | Needs posting status/date/period. |
| `statbar.linked` | `object_links` from VC to DX/AP/PS/PayrollRun/Purchase/Contract | BLOCKED until VC exists; object-links substrate exists | Do not show source-linked counts without VC rows. |
| `statbar.exceptions` | voucher validation rows: unbalanced, invalid GL account, missing source | BLOCKED by B21a | This is a validation field in the voucher domain, not a frontend heuristic. |
| `row.code` | `VC-...` canonical code | BLOCKED by B21a | Must be issued by backend/object registry; never fabricate `VC-` demo codes. |
| `row.status` | lifecycle/posting status | BLOCKED by B21a + lifecycle integration | Use status chips only. |
| `row.source` | `DX-` wf6 open-banking ingest, payroll run/PS, `AP-`, purchase request | PARTIAL backing: AP/workflow and purchase exist; DX/payroll are gaps; VC linkage blocked | Display only links that the row actually returns. |
| `row.amount` | balanced voucher debit/credit total | BLOCKED by B21a | Existing equipment cost ledger amount is not a GL voucher total. |
| `row.gl` | GL account code/name and line summary | BLOCKED by B21a | No current GL account model. |
| `link.lifecycle` | `/api/v1/lifecycles/finance_voucher/{id}` | substrate exists, object type blocked | Wire after B21a registers object type. |
| `link.objectGraph` | `/api/objects/{kind}/{id}/graph` | substrate exists, VC node blocked | Link only for resolvable VC nodes. |
| `link.auditTrail` | `/api/audit?target_type=finance_voucher&target_id=...` | audit route exists; target blocked | Add only when mutations emit target audit. |
| `link.sourceDx` | wf6/open-banking `DX-` ingest job | ingest gap #18 + B21a | `docs/design/oyatie-console/ROADMAP.md:94` is the intended chain: bank API DX -> Voucher -> Ledger. |
| `link.sourceAp` | `AP-` approval/workflow object | workflow backend exists | Only if voucher carries AP source/object link. |
| `link.sourcePayroll` | PayrollRun / `PS-` payslip | payroll REST gap #10 | Do not fabricate payroll source chips. |
| `link.sourcePurchase` | existing purchase request | exists for known purchase IDs; no list | Purchase can be a source chip only if B21a row links to it. |
| `link.costLedger` | equipment cost ledger entry | exists only by equipment ID | Treat as adjacent evidence, not GL ledger. |

## Current backend data that is real today

These fields are available and can be used only as linked evidence or adjacent source surfaces, not as substitutes for `VC-` vouchers:

- Financial REST paths include rental quote compute/create/get, equipment cost-ledger list/manual append/lifecycle cost, purchase request create/get/submit/admin approve/prepare expenditure/executive approve/reject/restart/execute, purchase preferences, and purchase attachment presign/confirm/download: `backend/crates/financial/rest/src/lib.rs:68-120`, route wiring `backend/crates/financial/rest/src/lib.rs:123-194`.
- `RentalQuoteSummary`: `id`, `branch_id`, `equipment_id`, acquisition/residual/cumulative repair values, `monthly_total`, quote lines, `created_at`: `clients/ts/src/schema.d.ts:6953-6969`.
- `CostLedgerEntrySummary`: `id`, `branch_id`, `equipment_id`, optional `work_order_id`, optional `purchase_request_id`, `source`, `amount_won`, `memo`, residual before/after, `entry_at`: `clients/ts/src/schema.d.ts:6980-6997`.
- `AssetLifecycleCostSummary`: equipment identity/status, acquisition basis, maintenance/manual/purchase totals, entry count, outsource read-only cost, residual/sale/margin/TCO, cost per month/hour, cost timeline: `clients/ts/src/schema.d.ts:7003-7037`.
- `PurchaseRequestSummary`: `id`, branch/equipment/work-order/evidence IDs, purchase type, vendor, amount, status, requester, lines, quote attachments, policy, expenditure no, rejection memo, timestamps: `clients/ts/src/schema.d.ts:7039-7078`.
- Existing financial role gates map to backend features, but are legacy financial capabilities rather than B21a voucher permissions: `backend/crates/platform/authz/src/lib.rs:352-359`, frontend mirrors in `web/src/features/financial/config.ts:14-63`.

## Backend fields blocked by B21a

B21a must supply these before the finance module can be fully wired:

- `finance_voucher.id`, `code` (`VC-...`), org/branch scope derived from principal
- voucher lifecycle/version fields: phase, version, pending revision, archive/dispose gates
- posting fields: `posting_status`, `posted_at`, `posted_by`, fiscal period / effective date
- GL model: account id/code/name, line debit/credit, balanced validation, invalid-account failure details
- source refs: typed links to wf6/DX open-banking ingest job, AP approval/run, payroll run/PS, purchase request/PO, contract/C, equipment/cost-ledger where applicable
- audit/trace fields emitted on create/post/revise/archive/dispose
- REST/DTO boundaries for list/read/create/post and object registry registration
- object graph integration so VC rows become typed graph nodes and link chips resolve through `object_links`

## Korean i18n keys to add

Add under `ko.console.modules.finance` (not under legacy `ko.financial`, because `web/src/console/**` must own the carbon-copy surface):

```ts
finance: {
  nav: "재무",
  title: "재무",
  objectName: "전표",
  emptyBlockedChip: "전표 도메인 대기",
  stats: {
    review: "검토 대기",
    posted: "전기 완료",
    linked: "원천 연결",
    exceptions: "예외"
  },
  search: {
    label: "전표 검색",
    placeholder: "전표·원천·계정·금액·거래처"
  },
  columns: {
    code: "전표",
    status: "상태",
    source: "원천",
    title: "내용",
    amount: "금액",
    gl: "계정",
    links: "연결",
    postedAt: "전기"
  },
  detail: {
    lifecycle: "생애주기",
    version: "버전",
    postingStatus: "전기 상태",
    period: "기간",
    voucherDate: "전표일",
    postedAt: "전기 시각",
    totalDebit: "차변 합계",
    totalCredit: "대변 합계",
    sourceKind: "원천 유형",
    sourceCode: "원천 코드",
    glAccountSummary: "계정 요약",
    orgScope: "조직 범위",
    branchScope: "지점 범위",
    createdBy: "작성자",
    auditTrace: "감사 추적"
  },
  links: {
    lifecycle: "생애주기",
    graph: "그래프",
    audit: "감사",
    dx: "오픈뱅킹",
    approval: "결재",
    payroll: "급여",
    purchase: "구매",
    contract: "계약",
    glAccount: "계정",
    costLedger: "원가원장"
  },
  actions: {
    createVoucher: "전표 생성",
    postVoucher: "전기",
    openSource: "원천 열기",
    openGraph: "그래프",
    openLifecycle: "생애주기",
    createRelation: "연결 추가"
  },
  statuses: {
    draft: "초안",
    review: "검토",
    active: "활성",
    posted: "전기 완료",
    revision: "개정",
    archived: "보관",
    disposed: "폐기",
    invalid: "예외"
  },
  sources: {
    dx: "오픈뱅킹",
    approval: "결재",
    payroll: "급여",
    purchase: "구매",
    contract: "계약",
    manual: "수기"
  }
}
```

UI copy constraints:

- Status must be chips, not explanatory subtitles.
- Blocked backend state should be a compact chip/empty state, not a paragraph explaining B21a to end users.
- Developer/test comments can cite B21a; visible UI should not expose internal blocker jargon except a compact operational chip if necessary.

## Policy-gated affordances

Every affordance is deny-by-omission through `PolicyGated` (`web/src/console/policy/PolicyGated.tsx:29-45`):

| Affordance | Policy action | Resource |
|---|---|---|
| screen/nav visibility | `finance_voucher_read` | `{ kind: "module", id: "finance" }` |
| row open/detail | `finance_voucher_read` | `{ kind: "finance_voucher", id }` |
| create draft voucher | `finance_voucher_create` | `{ kind: "finance_voucher" }` |
| post voucher | `finance_voucher_post` | `{ kind: "finance_voucher", id }` |
| open source chip | source-specific read (`workflow_task_read`, `purchase_request_read`, `payroll_read`, etc.) | target object kind/id |
| open lifecycle | `finance_voucher_read` plus lifecycle read | `{ kind: "finance_voucher", id }` |
| add relation | `object.link.create` | `{ kind: "finance_voucher", id }` |
| audit trail | `audit_log_read` | `{ kind: "finance_voucher", id }` |

Until B21a defines real backend feature keys, the frontend can use console-local action strings, but they must be mapped to `/me/authz`/feature grants before shipping beyond a local demo. Do not reuse legacy `EquipmentCostLedgerRead` or `PurchaseRequestCreate` to authorize voucher posting.

## Graceful constraints while B21a is absent

Implementation may proceed only as a constrained shell/config proof:

1. Register `finance` in the console module config and nav only if the route can render without fake rows.
2. Render the generic module shape with an empty dataset and compact blocked chip (`전표 도메인 대기`) or omit data-dependent controls entirely.
3. Hide `전표 생성`, `전기`, stat numbers, search results, and VC link chips until real `finance_voucher_*` data/actions exist.
4. It is acceptable to expose adjacent real links to legacy `/financial?tab=purchase`, `/financial?tab=ledger`, or `/equipment` only as command-center shortcuts if the generic template supports real route links and policy grants; do not draw those as VC voucher rows.
5. Do not synthesize `VC-` codes from purchase request IDs, cost-ledger entries, rental quotes, or AP approvals.
6. Tests should assert no fake `VC-` rows render before B21a and that denied policy removes actions instead of disabling them.

## Acceptance checklist for implementation child

- `finance` route/config exists under `web/src/console/**` and is composed by the generic module renderer.
- All visible strings are in `ko.console.modules.finance`.
- No Tailwind/shadcn/legacy AppShell imports inside new console module files.
- `StatusChip` handles all statuses; no duplicated status-shape helper.
- `PolicyGated` wraps nav, row detail, primary action, source chips, graph/lifecycle/audit links, and relation authoring.
- Every stat/row/link either maps to a real backend source above or is hidden/empty while B21a is absent.
- No fake VC codes, fake GL accounts, fake payroll runs, or fake wf6/DX objects appear in UI/tests.
- If B21a lands first, switch `emptyMode` to live list/read/create/post endpoints and add object/lifecycle/audit integration tests.
