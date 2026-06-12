# M1 Wave 1 — worker briefs

Same Hard Rules as `/Users/jasonlee/Developer/maintenance/.omc/team-briefs/m0-wave1.md` (read them). Plan: `.omc/plans/fsm-maintenance-plan.md` §M1 + §2. Spec: `.omc/specs/deep-interview-fsm-maintenance.md`.

### 1. T1.1 — registry domain + adapters + master-list importer (`backend/crates/registry/`)
- Crates per layering: `mnt-registry-domain`, `mnt-registry-application`, `mnt-registry-adapter-postgres`. Add `"crates/registry/*"` to workspace members.
- Domain: Equipment entity (장비No unique key + 호기(management no), model, VIN(차대번호), ton(톤수), 규격(좌식/입식), 동력(전동B/디젤D/LPG… — derive from 장비No prefix per the real file's MID() formulas: pos1=제조, pos2=종류, pos3=동력), 상태(임대/예비/폐기/대체 등 — survey actual values in the file), hours(가동시간), 차량가액, 잔존가(**CAN BE NEGATIVE** — i64/decimal, not unsigned), 임대료, 년식, 보험 fields, 자산처/자산등록일/임대시작일), Customer(계약처)/Site(사업장) entities, branch FK (kernel BranchId; importer assigns a default HQ branch — create one branch row in the importer if roster hasn't; document).
- Migration **0007** (registry tables: equipment, customers, sites; FKs; unique on 장비No; partial indexes for 상태).
- Importer: parses the REAL `docs/reference/master-list_251120.xlsx` (4 sheets — primary `K&L 지게차 Master list` header row 3 data rows 4..447, sheet 2 `예비 및 여유차량` header row 4 with 잔존가 col U incl. negatives; sheets 3-4 are pivots — DO NOT import, they're derived). Reader crate: verify live — `calamine` (read-oriented) or umya-spreadsheet (already a dep); pick and justify in commit.
- Idempotent upsert keyed on 장비No (호기 as secondary); reconciliation report struct (added/updated/unchanged/orphaned counts + row-level errors with sheet/row refs); dirty rows (missing 장비No, malformed dates) collected as errors, never panic, never partial-write a failed row.
- Tests (#[sqlx::test] + unit): import of the REAL file yields ≥440 equipment rows (assert exact count discovered from the file and pin it); re-import = no-op (0 added/0 updated); a modified copy produces correct reconciliation diff; 호기→model lookup query works (the 접수 use case: input #290 → GTS25DE-style answer); negative 잔존가 row roundtrips; 장비No prefix decomposition matches the file's own MID()-formula columns for all rows (self-consistency check against columns B-E).
- Full verification suite per Hard Rules before commit.
