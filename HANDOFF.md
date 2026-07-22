# HANDOFF — 물류장비(지게차) 정비/렌탈 FSM

**Purpose:** zero context loss between sessions. Update on every milestone transition, blocker, or merged task. (Pattern borrowed from oyatie.)

## 0. TL;DR — current state

- **Scope of this handoff:** fresh-session orientation for the maintenance repo. Treat it as topology/governance guidance, not as a release certificate; rerun the relevant build/test/CI checks before making completion claims.
- **Phase/ledger:** the historical M0–M6 implementation/review/hardening ledger is preserved below. The active readiness boundary is **G008 rollout**: OCI VM/TLS, production secrets, KCC 신고, Kakao templates, pilot seeding, signed mobile distribution, and restore drill. These are release/go-live gates, separate from repository build/test status.
- **Plan:** `.omc/plans/fsm-maintenance-plan.md` (consensus-APPROVED 2026-06-12, ralplan iteration 3) — task IDs T0.x–T6.x are stable, ledger references them
- **Spec:** `.omc/specs/deep-interview-fsm-maintenance.md` (interview-locked user decisions — do not relitigate)
- **M0 (13/13):** kernel · layer gate · schema+with_audit · 3 safety gates · auth · authz · Compose stack · observability/OpenSLO · backup/restore · Excel spike · compliance · provisioning · DR/PITR
- **M1 (12+gap-fixes):** registry+importer (445 units) · WO FSM (256-cell) · auth-REST · mobile surface · evidence/WORM · web+Android+iOS slice · tri-client codegen+drift · apalis soak ×2 · distribution pipeline · i18n
- **M2 (G003):** consent UI ×3 (T2.2) · dispatch P1 broadcast-accept FSM + GPS scoring + escalation timers (T2.4/T2.5, E2E sim proven). T2.3 KCC 신고 + T2.6 Alimtalk templates = **business actions (operator)**; code skips un-templated Alimtalk gracefully.
- **M3 (G004):** full messenger (T3.1/3.2/3.3) — persist-before-fanout, IDs-only LISTEN/NOTIFY <8000B, read receipts, FTS, tri-client.
- **M4 (G005):** Excel exports (일일현황/업무일지 golden-file), KPI 7종 + executive dashboard/kiosk (T4.1–4.5).
- **M5 (G006):** substitute matching (T5.1) · rental quote w/ negative-잔존가 flooring (T5.2) · cost ledger recompute (T5.3) · purchase/expenditure FSM (T5.4).
- **M6 (G007):** oyatie AI port (T6.1) · Bitween identity port (T6.2) · CI-GATES.md (T6.3) · inspection domain (T6.4) · GO-LIVE-CHECKLIST.md (T6.5). Review→harden→fix: 7 confirmed findings fixed+verified (2 security in `ffc8081`, 5 correctness in `258f622`); reports in `.omc/review/`.
- **Repository surfaces:** backend Cargo workspace, web React/Vite console, Android Kotlin/Compose app, and iOS SwiftPM/SwiftUI field app all exist in-tree. iOS also has `ios/project.yml` for CI-only XcodeGen XCUITest generation; the generated `.xcodeproj` is not committed, and TestFlight packaging/signing remains a release-lane concern.
- **Verification status:** previous handoffs recorded green suites/gates and web/Android/iOS build-test evidence, but those counts were point-in-time. Do not copy legacy suite/test counts as current HEAD status; cite fresh CI/local output instead.
- **Deployment claim boundary:** default `scripts/deploy.sh` is the documented path for a fresh "deployed and verified" claim: it must collect current Image Release digests plus live Argo/kubectl rollout, pod-image, and HTTP endpoint evidence. `--digest-bump-only` / `--bump-only` is desired-state-only for an explicit digest bump and must never be represented as deployed or verified.
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
| `web/` | React/Vite web console workspace (`@console/web`) with lint/test/build scripts. Built assets in `web/dist/` are repository artifacts only, not deployment proof. |
| `android/` | Kotlin/Compose field app Gradle project (`maintenance-field-android`) with JVM unit/Compose/Roborazzi and managed-device instrumented test topology. Play/internal-track release still requires signing and service-account secrets. |
| `.github/workflows/ci.yml` `android-instrumented` | Linux/KVM Gradle Managed Device Android post-login E2E. Every run uses PostgreSQL 18.4 plus the exact candidate backend, a random short-lived mechanic OTP, a mode-0600 runner-temp token fixture, and mandatory zero-skip/failure/error JUnit evidence; no external backend/session secret or optional self-skip path remains. |
| `ios/` | SwiftPM/SwiftUI field app (`MaintenanceField`) with core/app/tests/UITests. `ios/project.yml` generates a CI-only Xcode project for Simulator XCUITest; do not infer a committed distributable Xcode project/workspace from it. |
| `.github/workflows/ios-ui-tests.yml` | macOS/XcodeGen XCUITest + accessibility-audit workflow. Protected branch/required push contexts fail closed unless `MNT_UITEST_BASE_URL` plus one of `MNT_UITEST_REFRESH_TOKEN`/`MNT_UITEST_OTP` and the shared keychain entitlement are available; fork/optional contexts skip honestly and are not real post-login evidence. |
| `.github/workflows/release.yml` `.github/workflows/release-please.yml` | Tag/release automation entry points. Their presence does not prove production secrets, signing, Play upload, or TestFlight readiness. |
| `docs/reference/` | Golden Excel templates (DO NOT modify; CI golden-file fixtures) |
| `docs/decisions/` | ADRs (oyatie frontmatter convention) |
| `.omc/plans` `.omc/specs` `.omc/ultragoal` | Tracked planning/ledger artifacts |

## 3. External blockers status (updated 2026-06-12 by user)

- [x] Apple Developer Program account — **available** (T1.11 unblocked); distribution certificates, provisioning profiles, App Store Connect API key, and TestFlight lane secrets still gate release readiness.
- [x] Play Console account — **available** (T1.11 unblocked); Android upload keystore and Play service-account JSON still gate internal-track release readiness.
- [~] OCI Compute VM — **ready to provision**; when the deploy step arrives, provide SSH/OCI access (ops/README.md documents the steps)
- [~] KCC LBS 사업 신고 + Kakao Alimtalk 템플릿 — user confirms will be handled (M2 tasks proceed; T2.3/T2.6 record filing evidence when available)
- [ ] 경리/손화나 validation of rental-quote formula vs real 예비차량 data (M5)

## 4. Next up (dependency order)

Do not confuse repository/build evidence with go-live readiness. The engineering
ledger says M0–M6 are code-complete + reviewed/hardened, but **G008 remains a
release/operator-gated lane**: provision OCI VM + TLS, install production secrets
(`docs/release/SECRETS.md`), file KCC LBS 신고, submit Kakao Alimtalk templates,
seed branch/region + pilot roster, distribute signed mobile artifacts, and run
the restore drill on the real VM. See [docs/GO-LIVE-CHECKLIST.md](docs/GO-LIVE-CHECKLIST.md).

Mobile-specific boundary: Android internal-track upload requires the production
upload keystore + Play service account; iOS TestFlight requires App Store Connect
credentials, distribution signing material, and `IOS_XCODE_PROJECT` or
`IOS_XCODE_WORKSPACE`. The checked-in `ios/project.yml` supports CI XCUITest
generation, but it is not by itself a committed release packaging project.

## 5. Next-free resources (parallel-wave coordination)
- Next migration number: **0020** (0019 = `0019_harden_worm_and_alert_leases.sql`, harden wave 2)
- Crate families merged: kernel, platform/{auth,auth-rest,authz,db,storage,push,jobs,realtime,excel,provisioning}, workorder, registry, compliance, messenger, dispatch, reporting, financial, inspection, identity; ports: intelligence/AiAssistantPort(T6.1), identity/IdentityProviderPort(T6.2)
- Review findings: all 7 fixed+verified; finding #6 (reporting nullable branch_id) RESOLVED-AS-INTENDED (company/region rollup; scope_key authoritative).
