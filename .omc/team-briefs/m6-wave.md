# M6 + M2-consent wave briefs

Same Hard Rules as m0-wave1.md. Strict clippy (-D warnings) is part of done. NEXT-FREE MIGRATION: 0018 (claim sequentially; this wave: T6.4 uses 0018, T2.2 uses 0019 if it needs one — check first, consent tables exist from T0.11).

### 1. T2.2 — 위치정보법 consent UI on all 3 clients (+ T2.1 web export)
- Per m2-wave1.md Subtask 3. CHECK the contract first: consent grant/withdraw/suspend/resume/status + ping-ingestion HTTP routes — if MISSING from backend/openapi.yaml, ADD them (T1.3x pattern: rest crate over the merged mnt-compliance-application; T0.11 tables exist, likely NO migration needed; if one is needed it is 0019). Then build UI: web consent page + admin ledger CSV export; Android + iOS always-visible GPS off-switch + consent capture + on-duty-only gating. Withdrawal from any client → T0.11 destruction path.
- Update docs/parity-checklist.md (consent rows × android × ios) + keep parity/i18n gates green.
- Tests: backend consent routes audited + ping rejected without consent (403); client off-switch state machines (web vitest, android JVM, ios behavior-runner); parity + i18n green.

### 2. T6.4 — inspection domain (예방점검; unlocks KPI #6 순회이행률 + 정기검사 export section)
- crates/inspection/{domain,application,adapter-postgres,rest}. Migration **0018**: regular_inspection_schedules (equipment FK, mechanic FK 예방팀, cycle/interval, due_date, completed_at, branch-scoped) + inspection_rounds (per-visit records feeding 업무일지 순회점검 + 일일현황 정기검사 section).
- Wire the two honest-absence KPI hooks: reporting's 순회점검 계획 이행률 (#6) now computes from real schedules (replace the NotAvailable typed return — find it in crates/reporting, implement against this schema); the 일일현황 정기검사 section (T4.2 left it empty-with-note) now populates from inspection schedules due in range.
- 예방팀 flow: schedule creation (admin), assignment to 예방팀 mechanic, round completion (audited inspection.round.complete), feeds diary 순회점검.
- REST (utoipa, regen clients). Tests: schedule lifecycle audited; KPI #6 golden dataset now returns real ratio (not NotAvailable); 정기검사 export section populated (extend T4.2's export test); branch-scope.

### 3. T6.3+T6.5 — gate-suite doc + go-live checklist (docs; after the above merge)
- T6.3 docs/CI-GATES.md: enumerate every gate (db-migration-safety, pii-no-logs, audit-coverage incl. LocationPing-only-exclusion, layer-boundary incl. conflict-marker scan, WORM retention, parity, dual-build, i18n, openapi-drift, contract-roundtrip) — what each proves, how to run locally, where wired in CI. Assert all green on current main (run them, paste evidence).
- T6.5 docs/GO-LIVE-CHECKLIST.md: go/no-go items — consent destruction verified (T0.11/T2.2 evidence), KCC 신고 (user action — checkbox + where evidence goes), Alimtalk templates (user action), backup/restore drilled (T0.9 evidence), PITR drilled (T0.13 evidence), OTel/OpenSLO live, all gates green, both apps build, OCI provisioned (user action). Mark user-action items clearly. NO fake sign-offs.
