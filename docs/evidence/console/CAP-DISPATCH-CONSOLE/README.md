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

## Dispatch route composition and authority refinement

The active authenticated `/dispatch` page composes `DispatchConsoleBody` alongside
its pre-existing work-order list, dispatch board, controls, and mechanic-offer
flow. This narrow composition change does not alter route guards or navigation.

The new vertical is a manager operational queue/read surface. It intentionally
does **not** expose ACCEPT/DECLINE controls: those are person-scoped pending-offer
actions and remain on the existing mechanic offer workflow. The queue endpoint
cannot establish that the viewer received an offer, so showing response controls
there would impersonate an authority the UI cannot prove.

Only `MANAGER_FORCE_PENDING` dispatches can expose force assignment. A selected
candidate that has declined remains audit-visible but is disabled; any refreshed
candidate response list remounts the selector and clears an invalid selection.
A queue refresh that removes the selected work order invalidates the selection
and its detail request before rendering the empty queue state. Force-assignment
401/403, 409/server, and network failures remain in the module as explicit
fail-closed alerts rather than rejected event handlers.

A retained work order is not treated as authority-stable merely because its
work-order ID is unchanged. On every queue refresh, a changed P1 dispatch ID or
status invalidates the selection/detail epochs, clears the previously rendered
detail and action state, and starts a fresh detail request. The focused
regression keeps the old detail request deferred until after refresh and proves
it cannot restore the previous force-assignment state.
