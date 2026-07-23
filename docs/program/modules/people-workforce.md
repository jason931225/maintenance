# People & Workforce Administration

`POST /api/v1/employees` is the governed HR-admin creation path. It records a
tenant-scoped employee identity and employment profile, an `ONBOARD` lifecycle
event, and the audit event in one database transaction. `idempotency_key`
replays the original payload; a reused key with different normalized content is
a conflict.

The ordinary `GET /api/v1/employees` directory is paginated and intentionally
does not return phone or compensation. Those values are available only from
the HR-manager-only `GET /api/v1/employees/{id}` detail endpoint. Both paths
authorize before querying and query through tenant RLS, so a caller receives
neither cross-tenant data nor a count/object existence signal.

The console body in `web/src/console/people` uses these real endpoints for its
directory, branch selection, create flow, retry states, and refresh. Its
integration owner mounts it in the console screen registry; it does not carry
prototype data or masked compensation.
