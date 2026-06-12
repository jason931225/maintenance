# M5 Wave 1 — registry economics briefs

Same Hard Rules as m0-wave1.md.

### 1. T5.1 — substitute-equipment matching (extends crates/registry family)
- Use-case: given a down unit (by 호기/equipment id), list candidate 예비 units filtered by: same/compatible 톤수, 규격 (입식/좌식), 동력 (전동B/디젤D/LPG — from 장비No prefix), 상태=예비 (and not currently substituting elsewhere), with current 배치장소/사업장 and status. Ranking: exact ton match first, then nearest-above; document the compatibility rules in code + a doc comment sourced from the spec (대체장비: 유효설비/동일 기종ton수/입식 좌식/납산리튬엔진 유사시).
- REST: GET /api/v1/equipment/{id}/substitutes (utoipa; branch-scoped — candidates from the SAME branch by default with an all-branches flag for SUPER_ADMIN).
- Substitution assignment record (who took what where, when returned) — migration **0014** (equipment_substitutions), audited (equipment.substitute.assign/return). The 일일현황 export's 대체 status ties in later.
- Tests: golden fixtures from the REAL master list data shapes (incl. 미정 ton); matching excludes wrong 규격/동력; branch scope; assignment lifecycle audited.
- Re-emit openapi + regen clients; all checks green.

### 2. T5.2+T5.3+T5.4 — financial domain (one coherent worker; crates/financial family)
- Crates mnt-financial-{domain,application,adapter-postgres,rest}. Migration **0015**.
- T5.2 rental quote: configurable formula — inputs 취득가액, 잔존가액(현재), depreciation method 정액/정률 + 내용연수 + 잔존율, 수선비 이력(sum from cost ledger), 관리비율(%), 이윤율(%) → itemized monthly quote (감가상각비 + 수선충당 + 관리비 + 이윤 lines). Config per-branch defaults + per-quote overrides. NEGATIVE 잔존가 handled (real data has them — quote must not produce negative line items; floor at 0 with an explicit flag, document the business rule as configurable).
- T5.3 cost ledger: 정비비용 집행 entries (from purchase executions or manual admin entry, linked to WO when applicable) append to equipment_cost_ledger; 잔존가액 recompute per configured depreciation on each entry (audited equipment.residual.recompute with before/after).
- T5.4 purchase chain: PurchaseRequest FSM 거래명세표-attached(evidence pipeline reuse) → 구매요청서(접수자/경리 작성) → 관리자 승인 → 지출결의서 → threshold-based 임원 final approval (config: threshold KRW) → 집행기록(feeds T5.3 ledger). Every step role-gated (matrix semantics) + audited; rejection paths.
- REST for all three (quotes CRUD+compute, ledger read, purchase chain transitions); openapi + clients regen.
- Tests: quote golden cases incl. negative-residual unit from the real 예비 sheet shape; ledger recompute math (정액 and 정률); purchase chain role/threshold matrix (sub-threshold skips 임원, above requires), every transition audited; partial-rejection restart.
- NOTE: formula VALUES need 경리/손화나 validation (plan open question) — defaults must be config, not constants; mark the config file clearly.
