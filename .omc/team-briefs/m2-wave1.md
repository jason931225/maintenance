# M2 Wave 1 — worker briefs (P1 dispatch + compliance)

Same Hard Rules as `m0-wave1.md`. Entry gate T1.10 SATISFIED (soak evidence ×2 in docs/evidence/). Business actions T2.3 (KCC 신고) and T2.6 (Alimtalk templates) are user-handled — adapters/config must accept their outputs (template IDs, filing evidence) without code changes.

### 1. T2.4 — dispatch domain + worker (THE P1 engine)
- Crates: `mnt-dispatch-domain`, `mnt-dispatch-application`, `mnt-dispatch-adapter-postgres`, `mnt-dispatch-worker` (+ rest routes in the established pattern — accept/decline endpoints, broadcast status). Migration **0011**.
- Accept-window FSM (BROADCASTING/AUTO_ASSIGNED/MANAGER_FORCE_PENDING — SEPARATE from WO FSM per plan §2.2; on resolution it drives WO assignment via the existing T1.3 use-cases).
- Flow: P1 WO 등록 → broadcast rows for the equipment's branch/region technicians (fan-out target ≤5s server-side — measure in test); push via `mnt-platform-push` port (define the port + a real FCM HTTP v1 adapter; verify current google auth/fcm crate landscape live — plan §2.10 named apns-h2 0.11.0 for APNs; both adapters config-gated: absent credentials = adapter not wired, feature absent, NO mock); accept/decline with countdown (configurable window); ≥2 accepts → auto-assign by score = f(GPS distance IF consent+pings exist, current-work priority weight) — technicians without location consent rank by schedule-load only (ADR-0006/0014 interlock: assert in test); 0 accepts at timeout → MANAGER_FORCE_PENDING + manager alert; force-assign endpoint (admin-only, audited).
- Escalation timers through `mnt-platform-jobs` JobQueue (soak-proven); timers config-driven.
- Alimtalk adapter (`mnt-platform-push` or separate alimtalk module): aggregator REST (config: provider URL, key, template IDs — Solapi-compatible shape; verify current Solapi API docs live); absent config = disabled honestly.
- E2E multi-client simulation test: simulated technician clients accept/decline; assert ≤5s fan-out, scoring (incl. no-consent fallback), force-assign path, audit events for every transition, assigned tech's today-list (GET /work-orders?assigned_to=me) reflects immediately.

### 2. T2.5 — escalation chain (after T2.4; template IDs from user)
- Configurable chain: push (immediate) → no-ack N min → Alimtalk to assignee/manager → no-ack M min → manager 유선 alert surface (web wall-board flag + audit). Timers config; tests drive the chain with FixedClock/JobQueue.
- Config accepts user-provided approved 템플릿 IDs (T2.6 output); chain refuses to enable Alimtalk leg without them (clear startup log, not a crash).

### 3. T2.2 — 위치정보법 consent UI on all 3 clients (+ T2.1 web export)
- Web: consent management page (grant/withdraw/suspend per ADR-0014; admin: consent ledger view + CSV export); Android + iOS: consent capture at first login, ALWAYS-VISIBLE GPS off-switch (suspend = 비차단 즉시 — Art. 24), on-duty-only collection toggle honored by the ping sender.
- Clients send pings ONLY when: consent granted AND not suspended AND on-duty. Withdrawal from ANY client triggers the T0.11 destruction path (HTTP route exists? CHECK contract — if consent REST routes are missing, this task ADDS them (the T1.3x pattern): grant/withdraw/suspend/resume/status + ping ingestion endpoint, migration not needed (T0.11 tables exist), re-emit openapi + regen clients + drift green).
- Tests: backend consent routes audited; ping ingestion rejected without consent (HTTP 403-kind); withdrawal destroys pings (reuse T0.11 proofs at HTTP level); client unit tests for off-switch state machines on both natives + web.
