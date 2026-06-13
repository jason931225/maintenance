# HANDOFF — 물류장비(지게차) 정비/렌탈 FSM

**Purpose:** zero context loss between sessions. Update on every milestone transition, blocker, or merged task. (Pattern borrowed from oyatie.)

## 0. TL;DR — current state

- **Phase:** **M0–M6 CODE-COMPLETE + review→harden→fix DONE** (main `2347285`+). Ultragoal: G001–G007 done (checkpointing in progress); **G008 rollout BLOCKED on operator** (OCI VM, prod secrets, KCC 신고, Kakao templates, pilot seeding — see [docs/GO-LIVE-CHECKLIST.md](docs/GO-LIVE-CHECKLIST.md)).
- **Plan:** `.omc/plans/fsm-maintenance-plan.md` (consensus-APPROVED 2026-06-12, ralplan iteration 3) — task IDs T0.x–T6.x are stable, ledger references them
- **Spec:** `.omc/specs/deep-interview-fsm-maintenance.md` (interview-locked user decisions — do not relitigate)
- **M0 (13/13):** kernel · layer gate · schema+with_audit · 3 safety gates · auth · authz · Compose stack · observability/OpenSLO · backup/restore · Excel spike · compliance · provisioning · DR/PITR
- **M1 (12+gap-fixes):** registry+importer (445 units) · WO FSM (256-cell) · auth-REST · mobile surface · evidence/WORM · web+Android+iOS slice · tri-client codegen+drift · apalis soak ×2 · distribution pipeline · i18n
- **M2 (G003):** consent UI ×3 (T2.2) · dispatch P1 broadcast-accept FSM + GPS scoring + escalation timers (T2.4/T2.5, E2E sim proven). T2.3 KCC 신고 + T2.6 Alimtalk templates = **business actions (operator)**; code skips un-templated Alimtalk gracefully.
- **M3 (G004):** full messenger (T3.1/3.2/3.3) — persist-before-fanout, IDs-only LISTEN/NOTIFY <8000B, read receipts, FTS, tri-client.
- **M4 (G005):** Excel exports (일일현황/업무일지 golden-file), KPI 7종 + executive dashboard/kiosk (T4.1–4.5).
- **M5 (G006):** substitute matching (T5.1) · rental quote w/ negative-잔존가 flooring (T5.2) · cost ledger recompute (T5.3) · purchase/expenditure FSM (T5.4).
- **M6 (G007):** oyatie AI port (T6.1) · Bitween identity port (T6.2) · CI-GATES.md (T6.3) · inspection domain (T6.4) · GO-LIVE-CHECKLIST.md (T6.5). Review→harden→fix: 7 confirmed findings fixed+verified (2 security in `ffc8081`, 5 correctness in `258f622`); reports in `.omc/review/`.
- **Main:** 159 green suites / 240 tests / 0 failed; 4/4 gates; 49 crates; migrations 0001–0019; contract↔app stable; tri-client drift green; web/Android/iOS build+test green.
- **Ops lessons (persisted to memory):** never pipe codex exec stdout (stalls — confirmed again: both harden codex workers zombie-stalled 5h@0%CPU and were replaced by Claude executors); grep -c exits 1 on zero; sqlx prepare needs -- --all-targets; union-resolve shared-trailing-delimiter conflicts carefully (a union-strip dropped a Swift `}` + a ctor comma in the T2.2 merge — builds caught both).
- **Local env:** Rust stable pinned; Homebrew Postgres 18.4 (live-verified); Docker via colima; Node 24

## 1. Hard guardrails (persist)

1. **Production-grade only** — no stubs, no placeholders, no demo modes. Seams (oyatie AI, Bitween) are port definitions with no mock adapters.
2. **Audit-first** — every state transition/approval/assignment/chat message writes `audit_events` in the SAME transaction. Sole carve-out: `LocationPing` coordinates (위치정보법 destruction requirement, ADR-0014). The audit-coverage gate asserts the carve-out is the only exclusion.
3. **Branch-scoped everything, day 1** — non-nullable org scoping; cross-branch access default-denied.
4. **Verify-latest-deps** — every dependency version checked live (crates.io needs a User-Agent header) at add time; never from model memory.
5. **No completion claims without fresh verification evidence** (build/test/clippy output in the same session).
6. **Append-only migrations**; never destructive on `audit_events`.
7. **PII/PIPA**: no phone numbers, GPS coords, or 주민번호 in logs (pii-no-logs gate, T0.4).

## 2. Repo topology

| Path | Role |
|------|------|
| `backend/` | Rust Cargo workspace (modular monolith, `mnt-` prefix, layering `domain ← application ← adapter ← {rest,worker} ← app`) |
| `backend/crates/kernel/core` | `mnt-kernel-core` — typed IDs, AuditEvent, BranchScope, TraceContext, errors, Clock |
| `docs/reference/` | Golden Excel templates (DO NOT modify; CI golden-file fixtures) |
| `docs/decisions/` | ADRs (oyatie frontmatter convention) |
| `.omc/plans` `.omc/specs` `.omc/ultragoal` | Tracked planning/ledger artifacts |
| web/, ios/, android/ | To be created in M1 (React+shadcn; SwiftUI; Kotlin Compose) |

## 3. External blockers status (updated 2026-06-12 by user)

- [x] Apple Developer Program — **DONE** (T1.11 unblocked; signing keys/profiles to be set up in-task)
- [x] Play Console account — **DONE** (T1.11 unblocked)
- [~] OCI Compute VM — **ready to provision**; when the deploy step arrives, provide SSH/OCI access (ops/README.md documents the steps)
- [~] KCC LBS 사업 신고 + Kakao Alimtalk 템플릿 — user confirms will be handled (M2 tasks proceed; T2.3/T2.6 record filing evidence when available)
- [ ] 경리/손화나 validation of rental-quote formula vs real 예비차량 data (M5)

## 4. Next up (dependency order)

All engineering milestones (M0–M6) are code-complete + reviewed/hardened. The
only remaining work is **operator/business-owned** and gates pilot rollout
(G008): provision OCI VM + TLS, install prod secrets (`docs/release/SECRETS.md`),
file KCC LBS 신고, submit Kakao Alimtalk templates, seed branch/region + pilot
roster, distribute a signed pilot build, run the restore drill on the real VM.
See [docs/GO-LIVE-CHECKLIST.md](docs/GO-LIVE-CHECKLIST.md). No further engineering
is required to start the pilot once those are in place.

## 5. Next-free resources (parallel-wave coordination)
- Next migration number: **0020** (0019 = `0019_harden_worm_and_alert_leases.sql`, harden wave 2)
- Crate families merged: kernel, platform/{auth,auth-rest,authz,db,storage,push,jobs,realtime,excel,provisioning}, workorder, registry, compliance, messenger, dispatch, reporting, financial, inspection, identity; ports: intelligence/AiAssistantPort(T6.1), identity/IdentityProviderPort(T6.2)
- Review findings: all 7 fixed+verified; finding #6 (reporting nullable branch_id) RESOLVED-AS-INTENDED (company/region rollup; scope_key authoritative).
