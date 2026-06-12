# M3/M4/M6 wave briefs

Same Hard Rules as m0-wave1.md.

### 1. T3.2 — platform-realtime: WS hub + LISTEN/NOTIFY bridge (multi-instance correct)
- backend/crates/platform/realtime (mnt-platform-realtime): WebSocket hub behind a trait; per-connection mpsc (NEVER tokio broadcast as truth — plan §2.5/ADR-0007); Postgres LISTEN/NOTIFY bridge so a message persisted on instance A wakes subscribers on instance B.
- **IDs-ONLY NOTIFY payloads**: the notify port from T3.1 sends {thread_id, message_id} JSON; test asserts payload < 8000 bytes and that an oversize payload attempt is REJECTED at send time; subscribers re-read the message body from Postgres by ID.
- Wire T3.1's notify port to this real adapter; add WS route (/api/v1/ws) to mnt-app with JWT auth at upgrade; connection draining on SIGTERM (mnt-app already drains HTTP — extend).
- Integration test: two app router instances over ONE Postgres — send via instance A's REST, assert subscriber on instance B's hub receives the wake + re-reads the message (in-process two-instance test is acceptable and honest; document that true multi-process is covered by the compose stack).
- Tests: payload-size gate, lagging-consumer behavior (mpsc bounded — define + test the overflow policy: disconnect-with-resume-cursor, never silent drop), reconnect resume from last-read cursor.

### 2. T4.5 — web KPI dashboards + wall-board (web/ only)
- Executive KPI dashboard: 7 metrics from GET /api/v1/kpi (UnavailableMetric rendered as an honest '데이터 수집 전' state, not hidden), technician→branch→region→company rollup switcher (EXECUTIVE/SUPER_ADMIN), period picker.
- Wall-board kiosk route (/wallboard): auto-refresh (interval config), large type per UX research (TV-dashboard: low density, exception strip — overdue/awaiting-approval/urgent-unassigned counts prominent), Korean labels externalized.
- Daily-status + work-diary download buttons wired to the export routes IF present in clients/ts schema (T4.2/3 may not be merged when you start — check schema.d.ts; if absent, SKIP the buttons and note it: another task wires them. Do NOT invent routes).
- vitest coverage for rollup switching + unavailable-metric rendering + wallboard exception strip; lint/build green.

### 3. T6.1+T6.2 — integration seam ports (ports ONLY, no adapters, no mocks — ADR-0010)
- T6.1 mnt-intelligence-port (backend/crates/platform/intelligence or kernel-adjacent — justify): AiAssistantPort trait — diagnose(symptom, equipment_model) -> ProcedureChecklist, draft_report(wo_context) -> ReportDraft; rustdoc states the oyatie-cloud contract expectations; NO implementation, NO feature wiring (absent = absent).
- T6.2 IdentityProviderPort in mnt-platform-auth or new crate: user/role sync + attendance read shapes per the Bitween contract fields documented in the spec (tenantId/employeeId/externalUserId/attendanceStatus...); local identity REMAINS the real implementation; port compiles + rustdoc'd; tests = compile-time only (trait object safety) + doc examples.
- Both: layer gate must stay green; ADR-0016 (intelligence port) + ADR-0017 (identity port) recording the seam contracts (accepted status, frontmatter per existing ADRs).
