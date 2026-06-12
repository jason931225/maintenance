# HANDOFF — 물류장비(지게차) 정비/렌탈 FSM

**Purpose:** zero context loss between sessions. Update on every milestone transition, blocker, or merged task. (Pattern borrowed from oyatie.)

## 0. TL;DR — current state

- **Phase:** **G002 / M1 registry + WO core slice** (ultragoal 1/8 complete — **G001/M0 DONE & checkpointed 2026-06-12**, main `9883308`)
- **Plan:** `.omc/plans/fsm-maintenance-plan.md` (consensus-APPROVED 2026-06-12, ralplan iteration 3) — task IDs T0.x–T6.x are stable, ledger references them
- **Spec:** `.omc/specs/deep-interview-fsm-maintenance.md` (interview-locked user decisions — do not relitigate)
- **M0 (13/13):** kernel · layer gate · schema+with_audit · 3 safety gates · auth (SoftPasskey-proven) · authz (4-level 22-feature matrix) · Compose stack + mnt-app · observability (/api/audit self-auditing, OpenSLO) · backup/restore drill · Excel spike PASS · compliance (destruction proven) · provisioning · DR/PITR (lead-verified arbitrary-timestamp drill; VM-down rehearsal evidence)
- **M1 in flight:** T1.1 registry + master-list importer (codex worker). **Chain:** T1.2 WO FSM → T1.3 app/REST/OpenAPI → fan-out {T1.4 evidence, T1.5 web, T1.9 client-gen, T1.10 apalis soak} → T1.6 Android → T1.7 iOS → T1.8 parity · T1.11 distribution (NEEDS Apple/Google accounts — user) · T1.12 i18n
- **Main:** 52 green test suites / 0 failed; 4/4 gates PASS; 14 workspace crates; migrations 0001–0006
- **Local env:** Rust stable 1.96.0 pinned; Homebrew Postgres 18.4 (latest stable, live-verified); Docker 29.5.2 via colima; Node 24

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

T0.8 (observability + audit-read API) → M0 wrap → G002/M1.
