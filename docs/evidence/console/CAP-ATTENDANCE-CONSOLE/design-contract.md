# CAP-ATTENDANCE-CONSOLE — Backend Design Contract

New crate: `backend/crates/attendance` (members: `domain`, `adapter-postgres`, `rest` — leave/payroll crate shape).
Owns ONLY genuinely new domain state (design-spec §3, gap-analysis §2): exceptions + resolutions,
month closes + amendments, substitutions, week-52 acks. All reads of plans/records/leave/payroll
reuse existing REST. Everything is org-RLS (`app.current_org`), tested as `mnt_rt`, audited,
deny-by-omission (unauthorized = same 404/empty as nonexistent — no existence leakage).

## 1. FSMs

**Exception** (`attendance_exceptions.status`):
`OPEN → RESOLVED` (terminal; no reopen — a new fact raises a new exception).
Resolution is a separate append-only row; kind-specific gate:
- all kinds: `reason` non-empty (server 422 on blank — fail-closed, §4-27-2)
- `UNAPPROVED_OVERTIME`: additionally `linked_work_ref` required (work-scope object code, e.g. `WO-2638`); resolving emits a payroll material ref + audit naming the downstream chain (AT-ref → payroll exception).

**Month close** (`attendance_month_closes.status`):
`(absent = OPEN) → CLOSED`. No reopen/delete. Post-close corrections = append-only
`attendance_close_amendments` (retro adjustments; "마감 후 수정은 소급 보정으로 기록").
Close preconditions (server-recomputed at commit time, never trusted from client):
1. open exceptions for (scope, month) == 0 → else 409 `{open_exceptions: n}`
2. attest == true in request (human attestation, recorded with actor+ts)
3. soft warning (not blocking): pending leave decisions count returned in preflight.
Effects (single txn): insert close row (checks snapshot as JSONB evidence) → create payroll-domain
`period_lock` for the month via the platform helper, store `period_lock_id` → audit
`attendance.close.confirm` (code `AT-CLOSE`) → notification fan-out is the notifications owner's
consumer (outbox/audit-driven; not synchronous coupling).

**Substitution** (`attendance_substitutions.status`):
`ASSIGNED → CANCELLED` (cancel requires reason; append-only history via audit). Confirmation
(worker passkey contract receipt) is inbox-owner state; this table stores `approval_ref` /
`contract_ref` strings once the owning modules mint them (nullable until integration lands —
truthfully rendered as pending chips, never fabricated).

**Week-52 ack**: single append event per (employee, week_start); duplicate POST = idempotent 200.

## 2. REST surface (attendance/rest; prefix `/api/v1/attendance`; openapi tag `attendance` — manifest)

| Method+Path | Purpose | Authz (server-enforced) |
|---|---|---|
| `GET /api/v1/attendance/exceptions?work_date=&month=&status=&employee_id=&limit=&offset=` | List/filter AT- exceptions (day card, close readiness, month drill) | org-wide: `EmployeeDirectoryRead`; self rows always visible to linked employee |
| `POST /api/v1/attendance/exceptions` | Raise a manual exception (HR/detector) | `ATTENDANCE_EXCEPTION_MANAGE` |
| `GET /api/v1/attendance/exceptions/{id}` | Exception detail (detail lines, evidence refs, links, resolution) | as list; 404 outside scope |
| `POST /api/v1/attendance/exceptions/{id}/resolve` | Resolve with mandatory reason (+work link for OT) | `ATTENDANCE_EXCEPTION_MANAGE` |
| `GET /api/v1/attendance/substitutions?cover_date=&site=&limit=&offset=` | Assignments (timeline fill-in, month `abc` overlay, cover planner state) | `EmployeeDirectoryRead` |
| `POST /api/v1/attendance/substitutions` | Assign a substitute for a gap (today or future-dated) | `ATTENDANCE_SUBSTITUTION_MANAGE` |
| `POST /api/v1/attendance/substitutions/{id}/cancel` | Cancel with reason | `ATTENDANCE_SUBSTITUTION_MANAGE` |
| `GET /api/v1/attendance/closes?month=` | Close rows for all authorized entities + readiness (open-exception count, pending-leave warn) — powers the close card checklist and payroll's gate read | `EmployeeDirectoryRead` (aggregates only inside caller scope) |
| `POST /api/v1/attendance/closes/preflight` | Server-computed preflight for (branch_scope, month) — returns checks[] without committing | `PeriodLockManage` |
| `POST /api/v1/attendance/closes` | Confirm close (attest required; fail-closed) | `PeriodLockManage` |
| `POST /api/v1/attendance/closes/{id}/amendments` | Record a post-close retro adjustment | `PeriodLockManage` |
| `GET /api/v1/attendance/week52?week_start=` | Derived weekly totals + projection + ack state per employee in scope | `EmployeeDirectoryRead`; self row on the employee floor |
| `POST /api/v1/attendance/week52/acks` | Mark 근무 조정 요청됨 for (employee_id, week_start) | `ATTENDANCE_EXCEPTION_MANAGE` |

Notes: every route runs inside `with_org_conn` (RLS armed), records an hr-style read metric, and
emits `AuditEvent` on mutation. Listing endpoints paginate (`limit` clamp, `offset`), return
`{items, total}` pages like `attendance-summary`.

## 3. DTOs (openapi component schemas — names final, fields buildable)

```yaml
AttendanceException:
  { id: uuid, code: string,            # "AT-0703-02" — minted via object_code_counters
    kind: enum [LATE, NO_SHOW, UNAPPROVED_OVERTIME, EARLY_LEAVE],
    status: enum [OPEN, RESOLVED],
    employee_id: uuid, employee_name: string, team: string|null,
    branch_id: uuid|null, work_date: date, occurred_at: date-time,
    detail: string, evidence: [ {name: string, ref: string|null} ],
    links: [ {kind: string, label: string, code: string|null} ],
    resolution: AttendanceExceptionResolution|null,
    created_at: date-time }
AttendanceExceptionResolution:
  { action: enum [CONFIRM, APPROVE_OVERTIME], reason: string,
    linked_work_ref: string|null, ot_hours: string|null,   # decimal-as-string
    actor_user_id: uuid, resolved_at: date-time }
CreateAttendanceExceptionRequest:
  { kind, employee_id, work_date, occurred_at?, detail, branch_id?, links?, evidence? }
ResolveAttendanceExceptionRequest:
  { reason: string (required, non-blank), linked_work_ref?: string, ot_hours?: string }

AttendanceSubstitution:
  { id: uuid, site: string, branch_id: uuid|null, role: string,
    cover_date: date, from_minutes: int, to_minutes: int,        # minutes-of-day; partial covers (반차 09:00–13:00)
    covered_employee_id: uuid, covered_name: string,
    reason_kind: enum [NO_SHOW, APPROVED_LEAVE, HALF_DAY, LONG_TERM, OTHER], reason_detail: string|null,
    worker_employee_id: uuid|null, worker_name: string, worker_type: string,  # 일용직·파트타임·파견… snapshot
    worker_rate: string|null,
    status: enum [ASSIGNED, CANCELLED],
    approval_ref: string|null, contract_ref: string|null,        # AP-/C-D refs once owners mint them
    exception_id: uuid|null,                                     # NO_SHOW gaps link the AT- object
    created_by: uuid, created_at: date-time }
CreateAttendanceSubstitutionRequest:
  { site, branch_id?, role, cover_date, from_minutes, to_minutes,
    covered_employee_id, reason_kind, reason_detail?, worker_employee_id?, worker_name, worker_type,
    worker_rate?, exception_id? }
CancelAttendanceSubstitutionRequest: { reason: string }

AttendanceMonthClose:
  { id: uuid, month: string /* YYYY-MM */, branch_scope: string,  # entity/branch key ("coss"…) or branch uuid
    status: enum [CLOSED], attested_by: uuid, attested_at: date-time,
    checks: [ {key: string, ok: boolean, warn: boolean, note: string} ],  # committed preflight snapshot
    period_lock_id: uuid|null, closed_at: date-time,
    amendments: [ AttendanceCloseAmendment ] }
AttendanceCloseAmendment:
  { id: uuid, reason: string, detail: string, ref: string|null, actor_user_id: uuid, created_at: date-time }
AttendanceClosesPage:
  { month: string, items: [ AttendanceMonthCloseStatus ] }
AttendanceMonthCloseStatus:
  { branch_scope: string, closed: boolean, close: AttendanceMonthClose|null,
    open_exceptions: int, pending_leave: int }                   # readiness for the not-yet-closed rows
CloseAttendanceMonthRequest: { month, branch_scope, attest: boolean }
AttendancePreflight:
  { ready: boolean, checks: [ {key, ok, warn, note} ] }

AttendanceWeek52Row:
  { employee_id: uuid, name: string, team: string|null, week_start: date,
    current_hours: string, projected_hours: string,              # decimals-as-strings
    tone: enum [OK, WARN, DANGER],                               # thresholds are server config, not client constants (§4-16 RG-102)
    acked: boolean, acked_at: date-time|null }
AckWeek52Request: { employee_id, week_start }
```

Errors: uniform `{error: {code, message}}` envelope (ConsoleApiClient/`requireData` pattern);
422 blank reason / missing OT work link; 409 close blocked (`open_exceptions`), duplicate close,
period-lock conflict; 403 only when the resource is provably in-scope but the action is denied,
otherwise 404 (no leakage).

## 4. DDL — provisional migration `0188_create_attendance_console.sql`
(number provisional; integrator renumbers. Patterns copied from 0091/0107: composite (id, org_id)
PK+FK, RLS+FORCE `org_isolation` on `app.current_org`, `enforce_org_id_immutable`, append-only
triggers, `mnt-gate: audited-table` markers, mnt_rt grants per 0058.)

```sql
-- mnt-gate: audited-table attendance_exceptions
CREATE TABLE attendance_exceptions (
    id            UUID NOT NULL DEFAULT gen_random_uuid(),
    org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    code          TEXT NOT NULL,                             -- AT-MMDD-NN via object_code_counters
    kind          TEXT NOT NULL CHECK (kind IN ('LATE','NO_SHOW','UNAPPROVED_OVERTIME','EARLY_LEAVE')),
    status        TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
    employee_id   UUID NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    branch_id     UUID NULL REFERENCES branches(id) ON DELETE SET NULL,
    work_date     DATE NOT NULL,
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    detail        TEXT NOT NULL CHECK (btrim(detail) <> ''),
    evidence      JSONB NOT NULL DEFAULT '[]'::jsonb,
    links         JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, org_id),
    FOREIGN KEY (employee_id, org_id) REFERENCES employees(id, org_id) ON DELETE RESTRICT,
    UNIQUE (org_id, code)
);
CREATE INDEX attendance_exceptions_day_idx    ON attendance_exceptions (org_id, work_date, status);
CREATE INDEX attendance_exceptions_emp_idx    ON attendance_exceptions (org_id, employee_id, work_date DESC);
-- + RLS/FORCE org_isolation + trg org_immutable (0091 pattern)
-- status is the ONLY mutable column (guard trigger: UPDATE allowed solely OPEN→RESOLVED with same row values)

-- mnt-gate: audited-table attendance_exception_resolutions  (append-only)
CREATE TABLE attendance_exception_resolutions (
    id               UUID NOT NULL DEFAULT gen_random_uuid(),
    org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    exception_id     UUID NOT NULL,
    action           TEXT NOT NULL CHECK (action IN ('CONFIRM','APPROVE_OVERTIME')),
    reason           TEXT NOT NULL CHECK (btrim(reason) <> ''),
    linked_work_ref  TEXT NULL,
    ot_hours         NUMERIC(5,2) NULL CHECK (ot_hours IS NULL OR ot_hours > 0),
    actor_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    resolved_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, org_id),
    FOREIGN KEY (exception_id, org_id) REFERENCES attendance_exceptions(id, org_id) ON DELETE RESTRICT,
    UNIQUE (org_id, exception_id),                             -- one resolution per exception
    CHECK (action <> 'APPROVE_OVERTIME' OR linked_work_ref IS NOT NULL)  -- OT mandatory work link, DB-level
);
-- + RLS + platform_append_only_immutable trigger (0107 fn)

-- mnt-gate: audited-table attendance_substitutions
CREATE TABLE attendance_substitutions (
    id                   UUID NOT NULL DEFAULT gen_random_uuid(),
    org_id               UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    site                 TEXT NOT NULL CHECK (btrim(site) <> ''),
    branch_id            UUID NULL REFERENCES branches(id) ON DELETE SET NULL,
    role                 TEXT NOT NULL,
    cover_date           DATE NOT NULL,
    from_minutes         INT  NOT NULL CHECK (from_minutes BETWEEN 0 AND 1440),
    to_minutes           INT  NOT NULL CHECK (to_minutes BETWEEN 0 AND 1440 AND to_minutes > from_minutes),
    covered_employee_id  UUID NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    reason_kind          TEXT NOT NULL CHECK (reason_kind IN ('NO_SHOW','APPROVED_LEAVE','HALF_DAY','LONG_TERM','OTHER')),
    reason_detail        TEXT NULL,
    worker_employee_id   UUID NULL REFERENCES employees(id) ON DELETE RESTRICT,
    worker_name          TEXT NOT NULL CHECK (btrim(worker_name) <> ''),
    worker_type          TEXT NOT NULL,
    worker_rate          TEXT NULL,
    status               TEXT NOT NULL DEFAULT 'ASSIGNED' CHECK (status IN ('ASSIGNED','CANCELLED')),
    cancel_reason        TEXT NULL CHECK (status <> 'CANCELLED' OR btrim(coalesce(cancel_reason,'')) <> ''),
    approval_ref         TEXT NULL,
    contract_ref         TEXT NULL,
    exception_id         UUID NULL,
    created_by           UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, org_id),
    FOREIGN KEY (covered_employee_id, org_id) REFERENCES employees(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (exception_id, org_id) REFERENCES attendance_exceptions(id, org_id) ON DELETE SET NULL
);
CREATE INDEX attendance_substitutions_date_idx ON attendance_substitutions (org_id, cover_date, status);
CREATE INDEX attendance_substitutions_cov_idx  ON attendance_substitutions (org_id, covered_employee_id, cover_date);
-- + RLS; mutable columns limited to status/cancel_reason/approval_ref/contract_ref (guard trigger)

-- mnt-gate: audited-table attendance_month_closes
CREATE TABLE attendance_month_closes (
    id             UUID NOT NULL DEFAULT gen_random_uuid(),
    org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    month          DATE NOT NULL CHECK (date_trunc('month', month) = month),   -- first of month
    branch_scope   TEXT NOT NULL CHECK (btrim(branch_scope) <> ''),
    checks         JSONB NOT NULL,                                             -- committed preflight snapshot
    attested_by    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    attested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    period_lock_id UUID NULL,
    closed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, org_id),
    UNIQUE (org_id, month, branch_scope)                                       -- one close per scope-month
);
-- + RLS + append-only trigger (a close is immutable; corrections go below)

-- mnt-gate: audited-table attendance_close_amendments  (append-only retro adjustments)
CREATE TABLE attendance_close_amendments (
    id            UUID NOT NULL DEFAULT gen_random_uuid(),
    org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    close_id      UUID NOT NULL,
    reason        TEXT NOT NULL CHECK (btrim(reason) <> ''),
    detail        TEXT NOT NULL,
    ref           TEXT NULL,
    actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, org_id),
    FOREIGN KEY (close_id, org_id) REFERENCES attendance_month_closes(id, org_id) ON DELETE RESTRICT
);
-- + RLS + append-only trigger

-- mnt-gate: audited-table attendance_week52_acks  (append-only)
CREATE TABLE attendance_week52_acks (
    id            UUID NOT NULL DEFAULT gen_random_uuid(),
    org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    employee_id   UUID NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    week_start    DATE NOT NULL,
    actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, org_id),
    UNIQUE (org_id, employee_id, week_start),
    FOREIGN KEY (employee_id, org_id) REFERENCES employees(id, org_id) ON DELETE RESTRICT
);
-- + RLS + append-only trigger
-- GRANT SELECT/INSERT (+UPDATE where mutable) ON all five tables TO mnt_rt (0058 pattern)
```

## 5. Module completion mapping (console-enterprise-roadmap contract)

- **List/overview**: day board (plans ⨯ records ⨯ exceptions ⨯ substitutions) + month drill + stat bar; **object detail**: exception detail + EmployeeDay composition (audited view); **action/workflow**: resolve (mandatory reason), substitute assign (incl. future-dated cover planner), week52 ack, gated month close (preflight+attest); **history**: resolutions, amendments, audit stream.
- **≥2 upstream links**: employee/person card, daily work plan (workorder), leave request (leave), site/branch. **≥2 downstream**: payroll run gate + material refs, approval AP- refs, notifications, labor-cost series.
- **Authorization**: deny-by-omission at scope level (aggregates computed only inside caller's branch scope; out-of-scope ids → 404), self floor for own rows, RLS verified as `mnt_rt`.
- **State survival**: selection/drafts (resolve reason draft, close attest) are client concerns for stage 3; server idempotency (week52 ack unique, one-resolution-per-exception, one-close-per-scope-month) makes retry safe.
