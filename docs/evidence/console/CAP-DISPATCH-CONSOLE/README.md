# CAP-DISPATCH-CONSOLE — dispatch queue vertical evidence

## Implemented boundary

`web/src/console/dispatch/` owns a module-local operational dispatch vertical.
It consumes only generated `ConsoleApiClient` operations for:

- bounded `/api/v1/console/dispatch/queue` reads with typed status filters and
  opaque `after` cursor traversal;
- P1 dispatch summary, ranked-candidate, and response reads;
- authenticated ACCEPT/DECLINE responses; and
- `MANAGER_FORCE_PENDING` force assignment to a selected, server-returned
  candidate.

The screen has explicit loading, authorization-denied, error, and empty states.
Malformed 2xx queue/detail/candidate/response payloads fail closed through
`DispatchApiContractError`. Request epochs, abort signals, selection epochs, and
session-keyed mounting prevent stale reads from changing the visible selection.
Mutations refresh both the queue and selected P1 views.

## Deliberate non-claims

This vertical does **not** claim crew scheduling, vehicle telemetry, work-order
completion, inventory/cost accounting, route optimization, or candidate
workload interpretation. The currently generated contract does not expose a
safe read/write surface for those workflows, so the UI neither fabricates rows
nor presents inactive controls for them.

## Local verification

Run from the repository root (with workspace dependencies installed):

```sh
npm --workspace web test -- --run \
  src/console/dispatch/dispatchApi.test.ts \
  src/console/dispatch/DispatchConsole.test.tsx
npm run check:ts
./node_modules/.bin/eslint web/src/console/dispatch --max-warnings 0
node web/scripts/check-console-purity.mjs
node web/scripts/check-ui-strings.mjs
```

The focused tests exercise generated path/body wiring, malformed DTO rejection,
status filtering, opaque cursor follow-up, detail rendering, restricted force
assignment, refresh-after-mutation, and the denied state. They do not replace
backend authorization or full browser/runtime evidence.
