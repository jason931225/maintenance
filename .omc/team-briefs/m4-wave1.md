# M4 Wave 1 — reporting/KPI briefs

Same Hard Rules as m0-wave1.md.

### 1. T4.1 — platform-excel template-fill engine (extend the T0.10 spike crate)
- backend/crates/platform/excel exists (spike test proves umya-spreadsheet 3.0.0 round-trips the 일일현황 template). Build the real engine: load template → fill typed row data into sections → emit bytes; preserve merged cells/styles/dimensions (the spike's assertions become the engine's regression tests).
- API: template descriptor (sections with header rows, data-row ranges per the REAL files in docs/reference/), row-writer that EXTENDS section capacity correctly when data exceeds template rows (insert rows preserving section boundaries + downstream merges — this is the hard part; test it explicitly against section 3 미결누적 which grows unbounded).
- Golden-file tests: fill each of the 4 일일현황 sections with fixture data, re-read, assert structure + values; the 업무일지 3-sheet workbook (incl. the 143-merge calendar sheet) loads and round-trips.
- Pure platform crate: no sqlx/axum deps.

### 2. T4.4 — KPI 표준 7종 (crates/reporting domain family)
- mnt-reporting-{domain,application,adapter-postgres,rest}. Computation on approval-timestamp basis (adminApprovedAt-equivalent from work_orders), KpiExclusion honored (check schema: kpi_excluded on work_orders from migration 0008; if a kpi_exclusions audit table is absent, add migration 0013 for scoped exclusions WORK_ORDER/OUTSOURCE with revoked_at, per prior-project model).
- The 7 metrics (spec-locked, interview R3): ① 완료건수 (period, P1/P2/P3-weighted) ② 평균 응답속도 (접수→최초 IN_PROGRESS transition; P1 variant uses dispatch accept→start once M2 merges — compute from status_history now, note the P1 refinement) ③ 평균 완료소요일 + 목표일 준수율 ④ 재방문율 (REVISIT_REQUIRED ratio) ⑤ 지연율 + DelayReason 분포 ⑥ 순회점검 계획 이행률 — inspection-schedule data may not exist yet: CHECK migrations; if absent, define the metric behind the same computation port and return a typed NotAvailable error (ADR-0010 honest-absence pattern), report the gap ⑦ P1 수락률 — depends on dispatch broadcast data (T2.4 in flight): same honest-absence pattern if the table is absent at your base, with the computation written against the migration-0011 schema if present.
- Rollups: technician→branch→region→company (branch-scoped authz: EXECUTIVE/SUPER_ADMIN cross-branch per matrix).
- REST: GET /api/v1/kpi?period=&scope= (utoipa, regen clients, drift green).
- Golden-dataset #[sqlx::test] per metric: seed a known WO history, assert exact metric values incl. exclusion handling; rollup test across 2 branches.

### 3. T4.2+T4.3 — the two Excel exports (one worker; extends crates/reporting + uses platform-excel)
- T4.2 일일업무진행현황: build the daily snapshot from live data — 4 sections: ①실적 (completed today), ②계획 (planned/assigned today), ③미결누적 (all open WOs, unbounded — the engine's overflow insertion handles >32 rows), ④정기검사 (inspection schedules — table may be absent: honest-absence with empty section + typed note, consistent with T4.4's pattern). Columns per the REAL template (구분/No./접수날짜/사업장/관리호기수/모델/차대번호/불량내용/작업자/작업예정일/완료일/수리내용/Warning=Priority#N). GET /api/v1/exports/daily-status?date= returns the xlsx (content-disposition download); golden-file structural assertions vs docs/reference/일일업무진행현황_0605.xlsx (engine tests cover structure; THIS task's tests cover data mapping: a seeded WO set produces correct section membership + cell values). Export action audited (export.daily_status) + ExcelExportLog-style record (add to migration 0016 if needed).
- T4.3 업무일지: auto-generate daily from completed-WO + 순회점검 data into the 2-column 전일실적/금일예정 narrative + 긴급조치 점검/조치 entries (▶사이트 #호기 + 1)점검 2)조치 from report diagnosis/action fields); editable draft (store generated body, manager edits via API before confirm — draft/confirmed states, audited); export via engine matching 업무일지_26.05.27.xlsx structure (3 sheets; monthly-plan calendar sheet passes through from template). GET /api/v1/exports/work-diary?date= + draft CRUD routes.
- Re-emit openapi + regen clients; web console gets the download buttons in a LATER task (T4.5) — REST only here.
- Full verification suite + 4 gates.
