# Benchmark Matrix — Module: **finance** (GL vouchers / journal entries, document flow, balance verification, period locks)

**Scope:** How each product handles the general-ledger transaction: creating a voucher/journal entry, tracing it back to its source document, proving debit=credit and account validity, and locking a fiscal period so history can't be re-posted.

**Most-relevant vendors:** SAP (FI/GL — the reference implementation), Rippling (spend→GL sync), Palantir (Ontology writeback/Actions). Slack / Teams / Asana / n8n play only at the automation-and-approval edges of this module (see per-cell N/A reasons).

**Rigor:** every vendor claim is [V] VERIFIED (source URL) or [I] INFERRED (reasoned from known product patterns). Our column is code-evidenced from `/Users/jasonlee/Developer/maintenance`.

---

## OUR CONSOLE — actual state (code-evidenced)

Grepped `web/src/console/modules/{typeRegistry.ts,moduleScreens.ts,FinanceModuleScreen.test.tsx}`, `backend/crates/**`, `docs/program/console-program-ledger.md`.

- **Ontology-first grammar, not a hand-built screen.** `finance_voucher` is a first-class object type (`typeRegistry.ts:123`) with propSchema (`status`, `period`, `voucherDate`, debit/credit-won), typed relations `voucher_source → approval` (1:1, the 전자결재 link) and `voucher_cost → equipment` (1:N cost ledger), and an ontology analytic `balance = totalDebitWon − totalCreditWon` (`typeRegistry.ts:161`). The voucher screen, columns, stat strip, and detail links are all **projected from the ontology**, not coded per-field.
- **Document flow is modeled as object links.** Detail linkChips wire a voucher to its source across domains: `dx_ingest`, `approval`, `payroll_run`, `purchase_request`, `contract`, `gl_account`, `cost_ledger`, plus `lifecycle`, `audit_trail`, `object_graph` (`moduleScreens.ts:454-463`). This is lineage-as-graph, which is the design differentiator.
- **Period locks are REAL on the backend.** `backend/crates/platform/db/src/period_lock.rs` + migration `0107_create_period_locks_versioning_lifecycle.sql`; enforced under RLS and tested **as the runtime role** (`period_lock_blocks_ledger_as_runtime_role.rs`, `payroll_drain_period_lock.rs`). This is the one part of the module that is production-grade.
- **PBAC-gated.** Actions `finance_voucher_read|create|post` run through the Cedar `PolicyGate`; deny-read omits the whole module (`FinanceModuleScreen.test.tsx:95`).
- **But the GL engine itself is NOT built.** Ledger scores **module-finance 40 / fail**: "placeholder chips shipped (전표 도메인 대기), voucher REST missing, no stat values/CTA" (`console-program-ledger.md:183`). `createVoucher`/`postVoucher` carry `blockedUntil: "B21a finance VC-/GL backend"`. Endpoints (`/api/v1/finance/vouchers`, `…/post`) are declared but return no data. **Balance verification is a declared formula, not a server-enforced double-entry invariant.**
- **Korean-native by construction.** 재무/전표 labels, `voucher_source → approval` is the 전자결재 spine, org-scoped via RLS `app.current_org` (group-company / 법인 isolation).

**One-line honest self-assessment:** best-in-class *grammar and lineage design* + real period-lock substrate, sitting on top of an *unbuilt* posting engine and unenforced balance check.

---

## Capability Matrix

Legend: **[V]** verified w/ source · **[I]** inferred · **N/A** genuinely out of module.

### 1. Information architecture (how a GL transaction is modeled)
| Ours | SAP | Rippling | Palantir | n8n | Slack | Teams | Asana |
|---|---|---|---|---|---|---|---|
| `finance_voucher` object type in a shared ontology; header + typed relations, code-prefixed (VC-). [code] | Universal Journal: header in BKPF, line items in ACDOCA — one 360+-field table unifying GL/CO/AA/ML/CO-PA, up to 999,999 lines/doc. [V] | Spend transactions carry GL-coding fields that map to the customer's chart of accounts before sync; Rippling is not itself the GL. [V] | Generic Ontology objects (JournalEntry as an object type) with typed links; no native accounting schema. [I] | No data model of its own — passes JSON between accounting apps' APIs. [V] | Messages/forms; no GL object. **N/A** — collaboration layer. | Approval requests as objects; no GL object. **N/A**. | Tasks/custom-fields; no GL object. **N/A** — work mgmt. |

### 2. Voucher / journal-entry entry flow
| Ours | SAP | Rippling | Palantir | n8n | Slack | Teams | Asana |
|---|---|---|---|---|---|---|---|
| Create/Post actions declared + PBAC-gated, but `blockedUntil B21a` — flow not live. [code] | Park (draft) → Post; posting date auto-derives period & fiscal year; manual + recurring + template entries. [V] | Auto-generates JEs from card spend/bills/payroll; user rarely hand-keys — "coded to GL in real time". [V] | Actions create/edit/link objects with rule sets; a "create JournalEntry" Action would be built, not shipped. [I] | Xero native node covers Contacts/Invoices only; "Manual Journals" needs raw HTTP node. [V] | Form → routed message; no posting. **N/A**. | Approval form; no posting. **N/A**. | Task-form intake; no posting. **N/A**. |

### 3. Document flow / source-to-posting lineage
| Ours | SAP | Rippling | Palantir | n8n | Slack | Teams | Asana |
|---|---|---|---|---|---|---|---|
| Lineage is native: voucher linkChips to dx_ingest / approval / PO / contract / payroll + object_graph view. **Design lead.** [code] | Classic "Document Flow" / relationship browser: PO→GR→invoice→payment chain, drill-down to source. [V] | Card→expense report→reimbursement→GL coded end-to-end; source receipt attached to the synced line. [V] | Ontology links + writeback datasets capture full provenance of each edit back to system-of-record. [V] | Can *move* a doc between systems but keeps no lineage graph itself. [I] | Thread history only. **N/A**. | Comments+timestamps on the approval, not on a GL doc. [I] | Task attachments/subtasks; not GL lineage. **N/A**. |

### 4. Balance verification (double-entry debit=credit + valid GL account)
| Ours | SAP | Rippling | Palantir | n8n | Slack | Teams | Asana |
|---|---|---|---|---|---|---|---|
| `balance = ΣDr − ΣCr` declared as ontology analytic + `validation_status ∈ unbalanced\|invalid_gl_account`, but **not server-enforced yet**. [code] | Hard invariant: a document that isn't balanced cannot post; account/field validations + substitution rules at post time. [V] | Categorization/coding validated against CoA before sync; the double-entry invariant lives in the downstream GL, not Rippling. [I] | No built-in accounting invariant; you'd encode "Dr=Cr" as an Action validation rule. [I] | No validation engine; you'd script the check in a Function/IF node. [I] | **N/A**. | **N/A**. | **N/A**. |

### 5. Period locks / posting-period control
| Ours | SAP | Rippling | Palantir | n8n | Slack | Teams | Asana |
|---|---|---|---|---|---|---|---|
| **Real & RLS-tested as mnt_rt**: `period_lock.rs` blocks ledger writes into a closed period. **Production-grade.** [code] | OB52 / Manage-Posting-Periods app: closed periods block new postings; authorization-group override; special periods for adjustments. [V] | "Close the books faster" — but the period close/lock lives in the connected GL (QBO/NetSuite), Rippling feeds it. [V] | No native fiscal-period lock; modelled as object state + Action guard. [I] | No period concept. **N/A**. | **N/A**. | **N/A**. | Can gate a "close" task but no ledger period lock. **N/A**. |

### 6. Approval / four-eyes / SoD (전자결재)
| Ours | SAP | Rippling | Palantir | n8n | Slack | Teams | Asana |
|---|---|---|---|---|---|---|---|
| `voucher_source → approval` link is the native 전자결재 spine; SoD via distinct create/post PBAC actions. [code] | Park→release two-step, workflow for JE approval, authorization-object SoD; strong but config-heavy. [V] | Multi-level spend/bill approval policies before GL sync. [V] | Actions granularly permissioned (analyst opens, only managers close) — approval-as-permission. [V] | Orchestrates approvals across apps but has no opinion on SoD. [I] | Workflow Builder: forms + conditional branching (≤15+5 conditions), dynamic approvers, logged decisions. [V] | Approvals app: create/approve/reject/reassign, comments+timestamps, Purview audit. [V] | Native Approvals action inside Rules; move task on "Approved". [V] |

### 7. Permissions & scoping (group-company / 법인)
| Ours | SAP | Rippling | Palantir | n8n | Slack | Teams | Asana |
|---|---|---|---|---|---|---|---|
| Cedar PBAC + RLS `app.current_org`; deny-read hides whole module; Group→법인→branch→site scope. [code] | Company-code / authorization-object granularity; the enterprise reference but heavyweight to admin. [V] | Role-based; entity/subsidiary scoping for multi-entity spend. [I] | Per-Action writeback permissions by user group/condition. [V] | RBAC + SOC2; app-level, not GL-object-level. [V] | Workspace/channel ACL; not row-level financial scope. [I] | Team/tenant ACL; Purview governs audit. [I] | Project/team membership; not entity-scoped GL. **N/A** for GL scope. |

### 8. Automation hooks (auto-posting, rules, integrations)
| Ours | SAP | Rippling | Palantir | n8n | Slack | Teams | Asana |
|---|---|---|---|---|---|---|---|
| Vouchers auto-created from linked sources (payroll_run, purchase_request, dx_ingest) via ontology relations + workflow engine. [code/design] | BAPIs / substitution / recurring-entry / intercompany auto-posting; deep but ABAP-gated. [V] | AI-powered auto-categorization + policy rules auto-code every card txn to GL. [V] | Actions ↔ process models drive state transitions/writeback automation. [V] | **The specialist**: trigger/action nodes across QBO/Xero/Stripe; charges per workflow-run not per task. [V] | Conditional-branch workflows, no-code. [V] | Power Automate flows behind Approvals. [V] | Rules engine + Bundles (reusable template/rule packages). [V] |

### 9. Audit / compliance trail
| Ours | SAP | Rippling | Palantir | n8n | Slack | Teams | Asana |
|---|---|---|---|---|---|---|---|
| Tamper-evident hash-chain audit (L20, merged) + per-voucher audit_trail linkChip + bi-temporal versioning. [code/memory] | Full document change logs, audit trail, GoBD/SOX-grade; the compliance benchmark. [V] | Immutable spend audit trail feeding SOX close checklists. [I] | Writeback datasets = every edit versioned & attributable. [V] | Execution logs per run; not a financial audit trail. [I] | Logged decisions in threads; not tamper-evident. [I] | Purview audit log of every approval event w/ timestamps. [V] | Task activity log; not financial-grade. [I] |

### 10. Mobile
| Ours | SAP | Rippling | Palantir | n8n | Slack | Teams | Asana |
|---|---|---|---|---|---|---|---|
| Native field app exists (com.maintenance.field) but finance voucher UI not on it yet. [code] | Fiori mobile + S/4 mobile approve; JE entry is desk-work. [I] | Strong mobile: snap receipt, approve on phone. [V] | Mobile/Workshop apps; JE approval possible. [I] | No first-party mobile authoring. [I] | Full mobile approvals. [V] | Full mobile approvals. [V] | Full mobile app. [V] |

### 11. Extensibility (chart of accounts, dimensions, custom fields)
| Ours | SAP | Rippling | Palantir | n8n | Slack | Teams | Asana |
|---|---|---|---|---|---|---|---|
| Add a prop/relation in ontology → surfaces on voucher screen automatically; no per-screen code. **Design lead.** [code] | Coding blocks, custom fields via extension ledgers/CO-PA; powerful but consultant-gated. [V] | Fixed spend schema + GL-mapping config; not a modelling platform. [I] | Fully open Ontology — define any object/dimension. [V] | Generic HTTP node reaches any API field. [V] | Custom form fields only. [I] | Custom approval fields. [I] | Custom fields + Bundles. [V] |

### 12. Reporting / trial balance / close
| Ours | SAP | Rippling | Palantir | n8n | Slack | Teams | Asana |
|---|---|---|---|---|---|---|---|
| Stat strip (review/posted/linked/exceptions) declared; real trial-balance/close **not built** (backend missing). [code] | Real-time TB/P&L/BS off ACDOCA, no subledger reconciliation needed at close. [V] | Month-end-close checklist + faster close via real-time GL sync. [V] | BI/analytics off Ontology objects; you build the close app. [I] | Reports = sync data elsewhere. [I] | **N/A**. | **N/A**. | Close *checklist* as a project, not financials. [I] |

---

## Per-vendor: "how they'd build OUR finance module"

**SAP (FI/GL — the reference).** [V/I] They'd make the voucher a Universal-Journal line: one ACDOCA-style wide table, park→post with a non-negotiable Dr=Cr gate, OB52 period control with authorization-group overrides, and substitution/validation rules at post. Everything reconciles by construction — no subledger drift. The trade-off is exactly what our ontology avoids: configuration weight (posting-period variants, auth objects, ABAP substitutions) that needs a consultant. Our steal from SAP is the *invariant discipline*, not the admin surface.

**Rippling (spend).** [V] They'd never ask a human to key a voucher — the JE is a *byproduct*. Card swipe / bill / payroll run → AI auto-categorizes to the CoA → real-time GL-coded sync → month-end close checklist. They own the source-to-code automation and mobile receipt capture; they *don't* own the ledger, period lock, or double-entry invariant (that's the connected GL). Their philosophy maps cleanly onto our `voucher_source → payroll_run/purchase_request` links: the voucher should mostly *auto-materialize* from the linked source, not be typed.

**Palantir (writeback).** [V/I] Closest to our own grammar. JournalEntry becomes an Ontology object; "post voucher" is an Action with a validation rule (Dr=Cr) and granular writeback permissions (analyst drafts, controller posts) — approval-as-permission, exactly our create/post PBAC split. Period lock = object-state + Action guard. Provenance is free via writeback datasets. What they lack that we already have: a *real, RLS-enforced* period lock in the DB rather than a modelled guard.

**n8n (automation).** [V] They wouldn't build the module — they'd wire it. Trigger on an approved 전자결재, HTTP-node the voucher into the GL, sync to QBO/Xero. Native accounting nodes are shallow (Xero = Contacts/Invoices; Manual Journals need raw HTTP), so it's glue, not ledger. Relevant only as the *integration egress* pattern for our voucher→external-GL sync.

**Slack.** [V] N/A for the ledger; they'd own the *approval front-door*: Workflow-Builder form with conditional branching and dynamic approvers, logged decisions, then hand off to a real GL. Useful reference for how our 전자결재 request should *feel* (form + SLA + logged thread), not where it should live.

**Microsoft Teams.** [V] Same N/A on ledger; strongest at *audited approval*: Approvals app + Purview logs every create/approve/reject/reassign with timestamps. Reference for the audit-event granularity our audit_trail chip should expose.

**Asana.** [V] N/A for accounting; they'd model the *close as a project* — Rules + Approvals + Bundles to run a repeatable month-end checklist with handoffs. Reference for our close-orchestration UX, never for the numbers.

---

## What we'd steal (ranked, ontology-fit + cost)

1. **SAP's post-time Dr=Cr + valid-account invariant, enforced server-side.** → SAP does it best. Fit: we already declare `balance` + `validation_status` in the ontology — promote it from a display formula to a **DB/domain guard on `POST /vouchers/{id}/post`**, mirroring how `period_lock.rs` already guards writes. **Cost: M.** This is the single highest-leverage gap (unblocks `B21a`).
2. **Rippling's auto-materialized voucher from the source doc.** → Rippling best. Fit: our `voucher_source`/`voucher_cost` relations already point at approval/payroll/PO — have the workflow engine *emit* a draft voucher on source-doc finalization instead of a human creating it. **Cost: M** (needs the voucher REST first).
3. **Palantir's approval-as-permission + validation-in-Action.** → Palantir best. Fit: our create/post PBAC split *is* this pattern — formalize post as a Cedar-gated Action carrying the balance validation, so SoD and the invariant are one gate. **Cost: S** (extends existing PolicyGate).
4. **SAP's document-flow drill-down as the default voucher view.** → SAP best; Palantir close 2nd. Fit: we already have `object_graph` + linkChips — make the lineage graph the *primary* posted-voucher screen, not a secondary chip. **Cost: S** (UI wiring; graph exists).
5. **Teams/Purview audit-event granularity on the approval.** → Teams best. Fit: our L20 hash-chain audit is stronger *underneath*; surface the same event vocabulary (created/approved/reassigned + timestamp+actor) on the `audit_trail` chip. **Cost: S.**
6. **Slack Workflow-Builder form ergonomics for the 전자결재 request.** → Slack best. Fit: form + dynamic approver + SLA is the UX our approval-linked voucher intake should copy. **Cost: S–M.**
7. **n8n's per-run egress pattern for external-GL sync.** → n8n best. Fit: only if a customer keeps QBO/Xero/NetSuite as book-of-record — a voucher→external-GL sync job. **Cost: M**, and **YAGNI until a customer needs it** (we are the GL).

---

## Korean B2B fit notes (where global vendors mismatch)

- **전자결재 is structural for us, bolt-on for them.** SAP models JE approval as workflow config; Slack/Teams/Asana bolt an approval app on top. Our `voucher_source → approval` link makes the 전자결재 chain a *first-class edge of the voucher* — the correct local model. Steal the *ergonomics* (Slack forms, Teams audit) but keep our native link.
- **Group-company (법인) scoping:** SAP company-code + Rippling multi-entity both handle it; the collaboration tools (Slack/Teams/Asana) have no row-level financial entity scope. Our RLS `app.current_org` already wins here — don't regress to app-level ACL.
- **근로기준법 / payroll→GL:** Rippling's payroll-to-GL auto-sync assumes US payroll semantics; our `voucher_source → payroll_run` must carry Korean payroll (통상임금, 4대보험) coding — steal the *auto-materialize* mechanism, not the CoA mapping.
- **Period close culture:** Korean 결산 expects tamper-evident, auditor-facing history — our L20 hash-chain + RLS period lock is a genuine edge over Rippling's "feed the connected GL" model and even over Palantir's modelled-guard period state.

---

## Sources
- SAP Universal Journal / ACDOCA: https://blog.sap-press.com/what-is-saps-universal-journal · https://help.sap.com/docs/SAP_S4HANA_ON-PREMISE/651d8af3ea974ad1a4d74449122c620e/523b8a55559ad007e10000000a44538d.html
- SAP OB52 / posting-period control: https://learning.sap.com/courses/customizing-core-settings-in-financial-accounting-in-sap-s4hana/managing-posting-periods · https://sapsharks.com/ob52-open-and-close-fi-posting-periods/
- Rippling spend / bill pay / GL sync / close: https://www.rippling.com/blog/introducing-rippling-spend-management · https://www.rippling.com/blog/introducing-rippling-bill-pay · https://www.rippling.com/blog/month-end-close-checklist
- Palantir Ontology / Actions / writeback / permissions: https://www.palantir.com/docs/foundry/action-types/overview · https://www.palantir.com/docs/foundry/slate/applications-writeback · https://www.palantir.com/docs/foundry/ontology/overview
- n8n accounting nodes: https://n8n.io/integrations/xero/ · https://n8n.io/integrations/categories/finance-and-accounting/
- Slack Workflow Builder / approvals: https://slack.com/blog/news/conditional-branching-workflow-builder
- Teams Approvals + Purview audit: https://learn.microsoft.com/en-us/microsoftteams/approval-admin
- Asana Rules / Approvals / Bundles: https://asana.com/features/workflow-automation/rules · https://help.asana.com/s/article/approvals

**Our-console evidence:** `web/src/console/modules/typeRegistry.ts` (finance_voucher type, balance analytic), `web/src/console/modules/moduleScreens.ts` (screen, linkChips, endpoints, blockedUntil), `web/src/console/modules/FinanceModuleScreen.test.tsx` (PBAC gating), `backend/crates/platform/db/src/period_lock.rs` + `…/tests/period_lock_blocks_ledger_as_runtime_role.rs`, migration `0107_create_period_locks_versioning_lifecycle.sql`, `docs/program/console-program-ledger.md:183` (module-finance 40/fail).

---

## Cross-cutting lens findings (5 independent review lenses)

- **Task-flow:** money task = *approve a voucher/vendor bill*. Today it resolves in **0 usable steps** — the surface is dead (`blockedUntil B21a`, visual-verdict 40/fail). Concur = **1-click** approve from a rich single-glance card + mobile push; NetSuite = **bulk approve** (N bills, 1 action). **Steal (highest-ROI gap in the whole console):** (a) wire the voucher REST + object action so the money task exists at all; (b) 1-click approve-with-image glance card (Concur); (c) bulk/batch approve (NetSuite). Cost **L**.
- **IA / layout:** fully ontology-driven (columns from `finance_voucher.propSchema`), rich **link-chip graph** (voucher→DX/AP/payroll/purchase/contract/GL/cost_ledger), honest `blockedUntil` on unbuilt actions. **GAP:** single 22rem panel, no anchored multi-section **object page** — sub-objects (JE lines/GL) open only as chips that **navigate away, losing context**. **Steal:** SAP anchored in-panel sections (header→JE lines→GL→audit) [M]; smart-filter list report [M]; compact/comfort density toggle [S].
- **Data-model:** **weaker than SAP here — call it out.** SAP's **document principle is exactly our append-only-immutable philosophy, but populated and battle-proven for GL**; we have the append substrate but **no posting/voucher entity** (JP- "no table", VC- "no backend voucher table") — our single biggest data-model gap vs a category leader. **Stronger once built:** our revisions carry a hash chain (tamper-*evident*, not just resistant), and a voucher would inherit Cedar property-policy field-masking + as-of for free. **Steal:** SAP document principle as the voucher/posting entity spec (immutable header+lines, doc-type registry) [L]; extension-ledger parallel valuation [M]; number-range/doc-type registry [S].
- **Governance:** **Behind** — finance-specific governance (SoD ruleset for AP/AR, Σdr=Σcr balanced-document invariant, tolerance blocks, amount-threshold routing) is unbuilt. **Steal:** amount-threshold approval routing (>₩X → +1 approver level) as a typed policy predicate on the appr line → Workday BP [M]; balanced-document invariant as a publish-gate [M]; 3-way-match reconciliation object [L]; finance SoD ruleset seed (create-vendor vs approve-payment vs post-GL) → SAP GRC [M].
- **Automation / extensibility:** finance automation should be **document-triggered** (on-post → downstream), never free-form. **Steal:** document-posting trigger with tolerance gate (SAP 3-way match: GR/IR clearing nets within tolerance → auto-release/block) [L]; balanced-document invariant as a submission-criterion (predicate engine can express Σdr=Σcr) [M]; 부품부족→PO reorder monitor [M].

**Adjudication (preserve finance.md's period-lock nuance):** the governance and data-model lenses both describe finance as unbuilt and **omit the one production-grade piece — the period lock**, which is REAL, RLS-tested as `mnt_rt` (`period_lock.rs` + migration `0107` + `period_lock_blocks_ledger_as_runtime_role.rs`). There is no contradiction (all agree the GL/voucher engine is unbuilt), but the lenses under-credit finance's single shipped-and-tested strength. The period-lock nuance in §0 / Row 5 above stands.
