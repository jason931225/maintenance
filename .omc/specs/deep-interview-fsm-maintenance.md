# Deep Interview Spec: 물류장비(지게차) 정비/렌탈 FSM 시스템

## Metadata
- Interview ID: fsm-2026-06-11
- Rounds: 7 (+ Round 0 topology gate)
- Final Ambiguity Score: 16%
- Type: greenfield (with brownfield knowledge inherited from /Users/jasonlee/Developer/maintenance_system)
- Generated: 2026-06-12
- Threshold: 0.2 / Threshold Source: default
- Initial Context Summarized: yes
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.85 | 0.40 | 0.34 |
| Constraint Clarity | 0.85 | 0.30 | 0.26 |
| Success Criteria | 0.82 | 0.30 | 0.25 |
| **Total Clarity** | | | **0.84** |
| **Ambiguity** | | | **0.16** |

## Topology
| Component | Status | Description | Coverage / Deferral Note |
|-----------|--------|-------------|--------------------------|
| 1. 업무 코어 (WO & dispatch engine) | active | 접수→P1/P2/P3 triage→배정→계획승인→조치→완료승인 state machine; P1 broadcast-accept + GPS auto-assign; 외주 flow; 2인작업 | P1 model decided R2; lifecycle inherited from prior schema |
| 2. 정비사 모바일 앱 ×2 | active | **Swift(SwiftUI) iOS + Kotlin(Compose) Android 네이티브** — today's to-do, P1 수락/거부, 증빙 촬영, 오프라인 큐, passkey, native push | Platform decided R6 (user overrode Expo recommendation, informed) |
| 3. 사무실 웹 콘솔 | active | React(browser) — 접수 입력, dispatch board(Gantt+kanban+map), 승인 큐, 일일현황 wall-board, 임원 KPI 대시보드 | Desktop = browser per R4 |
| 4. 장비·고객사 레지스트리 | active | 마스터리스트(465대), 호기→모델 자동조회, 대체장비 매칭(예비/ton/입식좌식/동력) | Real Excel parsed; fields confirmed |
| 5. 감사형 풀 메신저 | active | WO스레드 + 팀채널 + 1:1 DM + 그룹 + 읽음표시/검색; TLS+at-rest, server-side audit, **NOT E2EE** | Scope decided R5 (full messenger, built-in) |
| 6. 리포팅·KPI 자동화 | active | 업무일지 자동생성, 일일업무진행현황 **Excel 양식 그대로 다운로드**, KPI 표준 7종 | KPI set decided R3; Excel templates in docs/reference/ |
| 7. 자산 경제성·임대견적 | active | 취득가/잔존가/수선비/정비비/관리비/이윤 → 견적; 정비비용 집계→잔존가 변동 | Fields exist in master list; formula = flagged assumption |
| 8. 구매·지출 결재 | active | 거래명세표→구매요청서→지출결의서→자금계획/대금집행 approval chain | Flow from user; actors = flagged assumption |
| 9. AI 어시스턴트 | **deferred** | 증상/모델→점검절차, 자동보고서 | User 2026-06-12: deferred until oyatie intelligence ready; **build the seam** (domain port + adapter stub for oyatie cloud intelligence) |

## Goal
Replace the company's KakaoTalk-based 정비 operations (접수, 업무지시, 사진공유, 완료보고, 미결관리) with a production-grade, auditable FSM system for a **300+ person, multi-branch (지점/지역) forklift maintenance/rental organization** (the 8 named staff — 정비팀 3, 예방점검팀 2, 관리자 3 — are the HQ/pilot team; rollout follows the prior 수도권→충청→영남→호남 phasing), covering the full work-order lifecycle with approval gates and evidence, P1 emergency broadcast dispatch with GPS auto-assignment, a full in-app messenger, automated KPI/업무일지/일일현황 reporting with exact-format Excel export, equipment registry with substitute matching, rental quoting, and purchase-approval workflows — professional, modern, intuitive UI on web (desktop) and two native mobile apps.

## Constraints
- **Backend**: Rust, clean architecture / ports-and-adapters mirroring oyatie layering (`domain ← application ← adapter ← {rest, worker} ← app`); Cargo workspace modular monolith, per-domain crates, compiler-enforced boundaries. Research-verified stack: Axum 0.8.x, tower-http, SQLx 0.9 (+ sqlx migrate, #[sqlx::test]), utoipa 5.x OpenAPI, apalis 1.0-rc (Postgres-backed jobs; isolate behind own trait), webauthn-rs 0.5.x, jsonwebtoken 10.x (short-lived access JWT ES256/EdDSA + opaque rotating refresh tokens, family reuse-detection), a2 (APNs) + FCM HTTP v1 adapters. **All versions re-verified live at implementation time (user mandate — never from training data).**
- **DB**: PostgreSQL. Per-request sessions; append-only audit-events table written in the SAME transaction as each state change (SELECT FOR UPDATE → validate transition → UPDATE → INSERT audit → COMMIT).
- **Object storage**: SeaweedFS primary self-hosted (user-approved fallback after RustFS verification failed: beta, disk-full metadata corruption, CVE-2025-68926) — hardened: no Filer/Admin UI exposed, pinned (slightly aged) releases, own WORM retention test suite. Offsite WORM replica to OCI Object Storage (S3-compat, retention-locked). All access via generic S3 port; RustFS re-evaluated at GA (~2026-07).
- **Auth**: passkeys-first; phone apps are WebAuthn anchors; desktop login via platform authenticator (Touch ID/Windows Hello) or cross-device (hybrid QR) WebAuthn; password/OTP fallback for older devices. AASA + assetlinks.json on RP domain; android apk-key-hash origins registered (debug + release/Play signing).
- **Mobile**: Swift/SwiftUI (iOS) + Kotlin/Compose (Android), feature parity enforced via shared OpenAPI-generated clients, shared design tokens, per-release parity checklist. Offline queue (prior design: device-hash + request-ID dedup, idempotent /sync).
- **Web**: React + TypeScript strict, shadcn/ui + Tailwind v4 (verified current), data-dense admin (TanStack Table, Gantt/kanban/map dispatch board), Pretendard font, KS X ISO 8601 dates, 48dp+ touch targets, WCAG AA.
- **GPS/위치정보법 (launch-blocking)**: per-employee individual consent records; always-visible in-app GPS off switch (non-refusable suspension); automatic destruction on withdrawal; on-duty-only collection; KCC LBS 사업 신고 legal review = business action item before go-live.
- **Push**: best-effort — P1 requires in-app acknowledgment loop with timed escalation (push → Kakao Alimtalk via aggregator (~13 KRW/건, Solapi/NHN) → 관리자 유선전화 알림). Timers configurable.
- **Deployment**: OCI Compute VM, Docker Compose production (vendor-endorsed pattern), Traefik HTTPS; K8s-ready posture (12-factor, probes, graceful shutdown, declarative config, OTel) — migration is config, not refactor. Local PC = dev only.
- **Quality attributes**: auditability + maintainability CRITICAL. OTel traces, structured logs; audit access role-gated and itself audited. oyatie discipline scaled down: ADRs (docs/decisions/), HANDOFF.md, MISTAKES-LEDGER.md, 3–5 CI quality gates (db-migration-safety, pii-no-logs, audit-coverage), OpenSLO files (manual review), lightweight registry/catalog YAML, evidence/ JSON for high-risk changes.
- **Integration seams (build now, fill later)**: oyatie cloud intelligence port (AI assistant); Bitween identity/attendance port (Bitween owns employee identity/attendance/payroll per prior roadmap; local accounts now, SSO bridge later).
- **Language**: Korean-only UI (i18n-ready resource structure).
- **Scale & org (R7, 2026-06-12)**: 300+ users across multiple 지점/지역. **Branch is a day-1 schema concept** (NOT nullable-later): P1 broadcast scoped to the equipment's branch/region technicians; permissions (ADMIN = branch-scoped, SUPER_ADMIN = all), KPI rollups (technician→branch→region→company), wall-boards, and chat team-channels are branch-scoped. Sizing: hundreds of concurrent users — comfortably single-VM Axum/Postgres territory, but WebSocket fan-out and job workers must be designed behind interfaces that allow multi-instance scale-out (Postgres LISTEN/NOTIFY bridge) since 300+ users on one node is the *starting* point, not the ceiling.
- **Production-grade-only mandate (2026-06-12)**: NO stubs, NO placeholders, NO demo modes anywhere in deliverables. Every milestone ships complete, tested, operable functionality. Prior project's demo-mode pattern is explicitly dropped. Integration seams (oyatie AI, Bitween) are port definitions with NO mock adapters — the feature is absent until the real adapter exists.

## Non-Goals
- E2EE messaging (incompatible with auditability requirement — explicit).
- PWA/web push for technicians (native apps only).
- Tauri desktop wrapper (desktop = browser, decided R4).
- Kubernetes operation at launch (K8s-ready only).
- Payroll/attendance ownership (Bitween's domain).
- RustFS at launch (re-evaluate at GA).
- AI assistant implementation (seam only).
- Customer(고객사) self-service portal (접수자 mediates; revisit post-launch).

## Acceptance Criteria
- [ ] WO lifecycle enforces the 16-state machine (inherited + P1 broadcast states) via explicit transition table; illegal transitions rejected at domain layer with tests for every transition.
- [ ] Every state transition/approval/assignment/chat message emits an append-only audit event (actor, before/after, timestamp, trace ID) in the same DB transaction; audit coverage verified by CI gate.
- [ ] Branch scoping: every WO/user/equipment/KPI/channel row carries org scope; cross-branch access denied by default and verified by authorization tests; SUPER_ADMIN/EXECUTIVE see cross-branch rollups.
- [ ] P1 flow: 등록 → **the equipment's branch/region** technicians + managers pushed within 5s (server-side); accept/decline with countdown; ≥2 accepts → auto-assign by (live GPS distance × current-work priority weight); 0 accepts after N min → manager force-assign alert + Alimtalk escalation; assigned tech's today-list updates immediately. Full E2E test with simulated clients.
- [ ] GPS consent: tech without consent record cannot be GPS-ranked (falls back to schedule-based); off-switch suspends collection ≤1 ping; withdrawal destroys location rows + collection logs (verified by test); consent ledger exportable.
- [ ] 일일업무진행현황 export reproduces docs/reference/일일업무진행현황_0605.xlsx 양식 exactly (4 sections: 실적/계획/미결누적/정기검사) — byte-level template fidelity validated against golden file; downloadable from web console.
- [ ] 업무일지 auto-generated daily from completed WO data in the 2-column (전일실적/금일예정) + 순회점검 + 긴급조치(점검/조치) format; editable before manager confirm; exportable.
- [ ] KPI 표준 7종 computed correctly on approval-timestamp basis with KpiExclusion honored — golden-dataset tests per metric.
- [ ] Passkey registration + login works on both native apps and desktop browsers (platform + cross-device QR flow); refresh-token reuse triggers family revocation (tested).
- [ ] Messenger: WO threads auto-created per 접수건; DM/group/team channels; messages persisted (Postgres) before fan-out (no broadcast-channel-as-source-of-truth); read receipts; full-text search; every message in audit store; media via presigned S3 URLs.
- [ ] Evidence media: mobile capture → local queue → presigned upload to SeaweedFS → offsite WORM replica verified; retention test suite (COMPLIANCE-mode put/delete-attempt) passes in CI against pinned SeaweedFS.
- [ ] Offline: technician can view today's jobs, start work, write reports, capture media with no connectivity; queue syncs idempotently (device-hash + request-ID dedup) on reconnect; per-item synced/pending indicators.
- [ ] Feature parity: every release passes the iOS/Android parity checklist (same user-visible capabilities); CI builds both apps from tagged commits.
- [ ] Substitute matching: given a down unit, system lists 예비 units filtered by ton/규격(입식·좌식)/동력 with current location/status.
- [ ] Rental quote: configurable formula over (취득가액, 잔존가액, 감가상각, 수선비 이력, 관리비율, 이윤율) produces itemized quote; 정비비용 집행 updates equipment cost ledger and recomputes 잔존가액 per configured depreciation.
- [ ] Purchase workflow: 거래명세표 첨부 → 구매요청서 → 승인 → 지출결의서 → 승인 → 집행기록; each step role-gated + audited.
- [ ] Compose stack boots from clean checkout with one command; health/readiness probes; OTel traces visible; nightly Postgres + SeaweedFS backup with restore runbook tested.
- [ ] Wall-board mode: 일일현황 dashboard auto-refreshing kiosk view (large type, exception strip).

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| RustFS for evidence storage | Adversarial verification: beta data-loss bugs, CVE, Object Lock misreporting | SeaweedFS + OCI WORM replica; RustFS re-eval at GA (user pre-approved) |
| PWA could serve technicians | iOS web-push home-screen gate, no silent push, best-effort delivery | Native apps + ack-loop escalation (user decided native first) |
| React Native frontend (original prompt) | User opened Swift/Kotlin door; simplifier challenge presented cost | **Dual native Swift+Kotlin** (user decision R6, informed) |
| "로컬 PC에서 실행" | Contrarian: field users need public reachability | OCI Compute VM prod; local = dev only (R4) |
| 거리순 자동배정 needs live GPS | 위치정보법 individual-consent + criminal penalties presented | User chose Broadcast + live GPS with full compliance workstream (R2) |
| K8s-native CNCF microservices | Industry evidence: Compose-prod is vendor-endorsed at this scale | K8s-ready posture, Compose-deployed; modular monolith |
| Broadcast-accept is industry standard | Verified: FSM leaders are dispatcher-mediated; broadcast is gig pattern | Deliberate departure, reasonable at 3-tech scale (R2) |
| Everything deferred to 추후 | User reversed | All in scope except AI (seam only) |

## Open Assumptions (planner defaults — validate during build, parameter-level only)
1. **Rental quote formula**: straight-line depreciation default, configurable (정액/정률, 내용연수, 잔존율, 관리비율, 이윤율) — validate with 경리/손화나 using real 예비차량 sheet data (잔존가 can be negative in real data — handle).
2. **Purchase approval actors**: 정비사 발주기록 → 접수자/경리 구매요청서 작성 → 관리자 승인 → 지출결의서 → 임원(전무) 최종승인 above threshold — thresholds configurable.
3. **P1 escalation timers**: accept-window 5min, force-assign alert at 10min, Alimtalk at no-ack 2min — all config.
4. **Bitween integration**: identity port designed now, local accounts at launch, SSO/attendance bridge per prior 6-phase roadmap later.
5. **HR roster**: minimal employee profile in-system (name/title/team/phone/roles); authoritative identity migrates to Bitween later.

## Technical Context
- Prior project /Users/jasonlee/Developer/maintenance_system (Next.js/Prisma, discarded code, kept domain): 16-state WO lifecycle, 5-role permission matrix (SUPER_ADMIN/ADMIN/MECHANIC/RECEPTIONIST/EXECUTIVE — add 예방점검팀 as MECHANIC sub-type or 6th role), TargetChangeRequest flow, DailyWorkPlan approval flow, KpiExclusion, DelayReason enum, offline sync design, 15 notification types (NEW_WORK_ORDER…FOLLOW_UP_DUE, verified against prior schema.prisma), file stages (REQUEST/BEFORE/DURING/AFTER/REPORT/OUTSOURCE_RESULT), AuditLog/ExcelExportLog patterns. Branch/멀티지점(branch_id) was flagged "must add day 1" by prior docs — superseded by R7 decision: **branch_id is a NON-NULLABLE day-1 schema concept** (see Scale & org constraint). Demo personas NOT carried (production-grade-only mandate).
- Excel reference files (authoritative, in docs/reference/): master-list_251120.xlsx (4 sheets, 465 units, fields incl. 장비No encoding/상태/규격/톤수/동력/가동시간/차량가액/잔존가/임대료), 일일업무진행현황_0605.xlsx (4-section daily sheet, Priority#N in Warning col), 업무일지_26.05.27.xlsx (2-column narrative + ad-hoc inspection sheets + monthly plan calendar).
- oyatie (/Users/jasonlee/Developer/oyatie): discipline reference only — ADR template/lifecycle, evidence-gate concept, OpenSLO convention, HANDOFF.md, mistakes ledger, registry/catalog YAML, per-service colocated layout.
- Research reports (3, adversarially verified, 2026-06-11): FSM industry baseline, Korea legal/notification, Rust stack, UI/UX + design systems — all findings embedded above.

## Ontology (Key Entities)
| Entity | Type | Fields (key) | Relationships |
|--------|------|--------------|---------------|
| Branch/Region | core | name, region, parent | scopes Users, Equipment, WOs, KPIs, channels |
| Equipment | core | 장비No, 호기, model, VIN, ton, 규격(좌식/입식), 동력, 상태(임대/예비/폐기), hours, 차량가액, 잔존가, 임대료, 사업장 | belongs to Customer/Site + Branch; has WorkOrders, CostLedger |
| Customer/Site | core | 계약처, 사업장, 배치장소 | has Equipment, WorkOrders |
| WorkOrder | core | requestNo, status(16), priority(P1-P3/OUTSOURCE), 불량내용, targetDue, resultType, kpiExcluded | Equipment, Assignments(N), Thread, Evidence, Approvals |
| Assignment | core | tech(s), role(주/부), acceptedAt | WorkOrder ↔ Technician (N:M, 2인작업) |
| P1Broadcast | core | acceptWindow, responses(accept/decline/timeout), autoAssignScore | WorkOrder; LocationPing |
| User/Technician | core | roles(5+), team(정비/예방), passkeys, devices | Assignments, Consents, KPI |
| LocationConsent | compliance | grantedAt, withdrawnAt, suspendedAt | User; gates LocationPing |
| LocationPing | compliance | coords, onDuty, ttl | User; destroyed on withdrawal |
| Approval | core | type(계획/완료/외주/구매/지출), actor, decision, memo | WorkOrder/DailyPlan/PurchaseRequest |
| DailyWorkPlan | core | planDate, status(DRAFT→FINAL_CONFIRMED), items | Technician, WorkOrders |
| EvidenceMedia | core | stage(BEFORE/DURING/AFTER…), s3Key, wormReplicaStatus | WorkOrder, WorkReport |
| ChatThread/Message | core | kind(WO/team/DM/group), readReceipts, audit | WorkOrder?, Users |
| DailyStatusReport | reporting | 4 sections, exportLog | WorkOrders snapshot |
| WorkDiary | reporting | diaryDate, body(2-col), confirmedBy | WorkOrders, PreventiveRounds |
| KpiSnapshot | reporting | 7 metrics, period, exclusions | Technician/team |
| RentalQuote | financial | formula params, itemized lines | Equipment |
| PurchaseRequest/Expenditure | financial | 거래명세표 attach, chain status | WorkOrder?, Approvals |
| OutsourceVendor/Work | core | vendor, status, cost, resultDesc | WorkOrder |
| RegularInspectionSchedule | core | equipment, mechanic, dueDate | 예방점검팀 rounds |

## Ontology Convergence
| Round | Entities | New | Changed | Stable | Stability |
|-------|----------|-----|---------|--------|-----------|
| 1 | 15 | 15 | - | - | N/A |
| 2 | 17 | 2 (LocationConsent, LocationPing) | 0 | 15 | 88% |
| 3–6 | 17→19 | refinements (P1Broadcast, EvidenceMedia formalized) | 0 | all | ~100% |

## Interview Transcript (summary)
<details><summary>6 rounds</summary>

- **R0 Topology**: 6 components + 4 deferrals proposed → user: "Don't defer anything" (later: AI re-deferred with oyatie seam). 9 components locked.
- **R1 Excel files**: "design from industry baseline but use those files" → found TalkFile_* in ~/Downloads, copied to docs/reference/, parsed. New requirement: 일일현황 Excel 양식 그대로 + downloadable. Prior project discovered & reconned.
- **R2 P1 dispatch**: evidence presented (industry dispatcher-mediated; 위치정보법) → **Broadcast + 실시간 GPS** with compliance workstream.
- **R3 KPI**: → **표준 7종** adopted.
- **R4 Deployment (Contrarian)**: "로컬 PC" challenged → **OCI Compute; desktop=browser, mobile=native apps**.
- **R5 Chat scope**: → **풀 메신저** (built-in).
- **R6 Mobile (Simplifier)**: Expo recommended with evidence → user chose **Swift + Kotlin 네이티브 2종** (informed decision).
</details>
