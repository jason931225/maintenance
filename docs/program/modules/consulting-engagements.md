# Consulting engagement and realized benefit pilot

`/api/v1/consulting/engagements` is a tenant-scoped pilot for one closed loop:
create a customer engagement and diagnostic, attach evidence-backed findings,
propose a KPI-definition-referenced initiative, record approval/workflow IDs,
complete implementation review, record an evidence-linked observation, and
make a sustained or corrective decision.

The module stores IDs for customer, customer document, approval, workflow,
ontology instance, KPI definition, document, and evidence. It deliberately does
not copy KPI values; reporting remains the KPI authority. Every mutation writes
an append-only `consulting_engagement_history` row, transitions use the returned
`version` as an optimistic-concurrency token, and creation is idempotent per
tenant key. All six tables have forced PostgreSQL RLS keyed to `app.current_org`.

Read access uses the existing management-read policy gate and writes use the
existing management-write gate until the policy catalog gains dedicated
`consulting_read` and `consulting_manage` enum entries. The database feature
catalog rows are already seeded, so that policy extension is a narrow follow-up,
not a client-side authorization bypass.
