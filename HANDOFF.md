# HANDOFF — 물류장비(지게차) 정비/렌탈 FSM

**Purpose:** zero context loss between sessions. Update on every milestone transition, blocker, or merged task. (Pattern borrowed from oyatie.)

## 0. TL;DR — current state

- **Phase:** G001 / M0 platform spine (ultragoal `.omc/ultragoal/`, 0/8 goals complete)
- **Plan:** `.omc/plans/fsm-maintenance-plan.md` (consensus-APPROVED 2026-06-12, ralplan iteration 3) — task IDs T0.x–T6.x are stable, ledger references them
- **Spec:** `.omc/specs/deep-interview-fsm-maintenance.md` (interview-locked user decisions — do not relitigate)
- **Done:** T0.1 kernel, T0.2 layer gate, T0.3 schema+with_audit (PG 18.4), T0.6 authz matrix (primary-source 가능/제한/불가/요청 levels), T0.10 Excel spike PASS (umya 3.0.0, ADR-0008)
- **In flight (codex exec, gpt-5.5 xhigh, worktrees):** T0.4 CI gates, T0.5 platform-auth, T0.7 Compose+mnt-app, T0.11 compliance domain
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

## 3. Known external blockers (user/business actions — checkpoint as ledger blockers when reached)

- [ ] OCI Compute VM provisioning + credentials (T0.7 deploy target)
- [ ] Apple Developer Program + Play Console accounts, signing keys (T1.11)
- [ ] KCC LBS 사업 신고 filing (T2.3 — launch-blocking legal)
- [ ] Kakao Alimtalk template submission via aggregator (T2.6 — multi-day lead)
- [ ] 경리/손화나 validation of rental-quote formula vs real 예비차량 data (M5)

## 4. Next up (dependency order)

T0.4 (CI gates: audit-coverage w/ carve-out reconciliation, migration-safety, pii-no-logs) → T0.5 (passkeys/JWT) → T0.6 (authz) → T0.11 (compliance core) → T0.12 (provisioning) → T0.7–T0.9, T0.13 (Compose/obs/backup/DR — needs Docker) → M0 wrap → G002/M1.
