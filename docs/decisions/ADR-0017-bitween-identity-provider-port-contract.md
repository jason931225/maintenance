---
id: ADR-0017
status: accepted
doc_status: published
date: 2026-06-12
owner: codex/t61
consensus: implements ADR-0010 under ADR-0001 layering
related: [ADR-0001, ADR-0004, ADR-0010]
---

# ADR-0017 - Bitween identity provider port contract

## Status
Accepted.

## Context
Bitween will own employee identity, attendance, and payroll. This system owns
work orders, KPI, approvals, and local launch accounts. ADR-0010 requires the
Bitween seam now with no mock adapter, while ADR-0004 keeps local passkey-backed
accounts as the real launch identity source.

The known Bitween contract fields include `tenantId`, `employeeId`,
`externalUserId`, and `attendanceStatus`. The current `mnt-platform-auth` crate
contains concrete auth behavior and SQLx-backed token/passkey support, so adding
the future provider port there would mix an application contract into an
outer-layer implementation crate.

## Decision
Create `mnt-identity-application` and define `IdentityProviderPort` there.

The port exposes:
- `sync_users_and_roles(request) -> UserRoleSyncPage`
- `read_attendance(request) -> AttendancePage`

The contract preserves Bitween field names at the serialization boundary via
camelCase serde fields. Attendance rows carry both the raw Bitween
`attendanceStatus` code and a small normalized category that downstream
work-order use cases can consume without taking ownership of payroll or
attendance semantics.

No adapter, mock, route, or UI affordance is added. Local accounts remain the
only real implementation until a production Bitween adapter exists.

## Alternatives Considered

### Add the port to `mnt-platform-auth`
Rejected. `mnt-platform-auth` is already an outer platform implementation crate
with SQLx/runtime dependencies. The Bitween provider contract belongs in an
application-layer crate so future adapters depend inward on it.

### Add a full identity domain now
Rejected. The current task is ports only. Creating identity domain entities or
repositories would exceed ADR-0010 and risk implying an implementation that does
not exist.

### Mock Bitween adapter
Rejected by ADR-0010 and the production-grade-only mandate.

## Consequences
+ The future Bitween adapter has a stable, dyn-compatible contract to implement.
+ Local auth stays untouched and remains the production identity path.
- The identity application crate is contract-only until a real identity use case
  consumes it.
