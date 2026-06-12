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
