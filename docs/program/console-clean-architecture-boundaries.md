# Console clean-architecture boundaries

## Purpose

The console is developed by multiple independent lanes. Architecture boundaries are
therefore a scheduling contract as well as a design preference: an agent can change
a domain/use-case or a transport adapter without concurrently editing the route
shell, generated API client, or another module's private files.

`node scripts/architecture/check-boundaries.mjs` is a deterministic, zero-network
static gate. It emits JSON with `violations`, known `debt`, and blocking `failures`.
Use the changed-path mode in a presubmit/agent lane:

```sh
node scripts/architecture/check-boundaries.mjs \
  --changed-path web/src/features/equipment/adapters/equipmentApi.ts \
  --changed-path backend/crates/registry/application/Cargo.toml
```

`--changed-paths-file <newline-delimited-paths>` is equivalent for a generated
changed-file manifest. Full mode is appropriate for a consolidation or debt-removal
lane. Output paths and IDs are repository-relative and sorted, so independent lanes
can compare receipts without worktree-specific noise.

## Backend contract

The dependency direction is:

```text
domain <- application and ports <- adapters and REST <- composition root
```

- **Domain** owns entities, value objects, invariants, and lifecycle policy. It has
  no Axum, SQLx, HTTP, client, or UI dependency.
- **Application/ports** owns commands, queries, use cases, and interfaces. It may
  depend on domain, never an adapter, REST, or framework transport/persistence API.
- **Adapters** implement ports and map persistence/external concerns. They may use
  application and domain, never REST.
- **REST** authenticates, authorizes, validates/maps DTOs, invokes a use case, and
  maps its result. Lifecycle transitions belong in domain/application, not handlers.
- The composition root supplies concrete implementations and is the only outer
  wiring layer.

`backend/crates/registry` (the Equipment backend) is the reference component:
`domain`, `application`, `adapter-postgres`, and `rest` are independently owned
surfaces. New backend components should follow that shape when they have meaningful
logic; the gate deliberately does **not** require empty crates.

## Frontend contract

The direction for a structured feature is:

```text
reusable UI primitives -> headless console capabilities -> feature domain/application
  -> transport adapters -> feature UI and route composition
```

A feature may adopt `domain/`, `application/`, `adapters/`, and `ui/` incrementally.
The checker only enforces a layer after that layer exists; it never asks a flat feature
to manufacture folders. Generated `@maintenance/api-client-ts` types terminate in
`web/src/api/` or a feature's `adapters/` layer. UI consumes feature-owned types and
commands, not generated transport types.

Feature-to-feature imports must use the target feature's `public.ts` or `index.ts`
surface. Shared reuse is deliberately narrow: accessible primitives belong in
`components/ui`; headless cross-module capabilities belong in `console/`; business
vocabulary and policy remain feature-owned. Do not add `web/src/shared` or
`components/shared` as a generic dumping ground.

Equipment's frontend is currently flat under `web/src/features/equipment`. Stage its
internal boundaries as changes touch it: first isolate transport calls in `adapters`,
then extract domain/application state, then keep panels/routes as UI composition.
This avoids a blocking rewrite while making new Equipment work independently
parallelizable.

## Baseline debt and enforcement

`scripts/architecture/exception-ledger.json` records every violation present at the
PR-488 integration anchor. These are explicit migration debt, not a waiver: do not
add entries for new code. A changed-path run fails when a changed file introduces an
unledgered violation; as files are migrated, delete their ledger entry in the same
change. The baseline lets present work fan out safely while a dedicated migration lane
reduces debt.
