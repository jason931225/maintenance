# Equipment 3R handover evidence custody

Equipment 3R does not accept storage paths, URI schemes, or caller-asserted
immutability at handover. It receives an `evidenceObjectId` UUID and delegates
the eligibility decision and custody relation to Docs/Evidence in the same
PostgreSQL transaction.

A handover is eligible only when Docs/Evidence proves all of the following for
the tenant-scoped object:

- exactly its `ORIGINAL` copy is `VERIFIED` WORM and has `verified_at`;
- the object is `ADMISSIBLE`;
- the object is not disposed and is not in the `DISPOSED` custody stage; and
- the immutable Docs-owned custody row matches the Equipment case and its
  dispatch-authorized branch.

`docs_equipment_handover_custody` is append-only, tenant-isolated by FORCE RLS,
and rechecks both the Equipment case branch and evidence eligibility in a
PostgreSQL trigger. A foreign organization is concealed as not found; a caller
without authority for the case branch is denied before custody resolution.

## Generated-face consolidation required

This leaf changes `Cargo.toml` dependency edges but intentionally does **not**
edit generated `BUCK` files, OpenAPI, generated clients, or route registries.
The shared-face consolidator must run `python3 tools/buck/gen_first_party.py`
once after integrating this leaf, then validate the generated-face registry and
re-run the Equipment integration target. The public REST contract must be
updated in the consolidated OpenAPI/client epoch from `evidenceReference` to
`evidenceObjectId`; this leaf keeps the server implementation and its runtime
story ready for that single-writer step.
