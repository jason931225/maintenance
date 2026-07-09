/**
 * Fidelity states for the P0.4 generic module template (charter §3 P0.4, D2.1).
 *
 * `capture.mjs --screen=module` navigates the BUILD side to each state below
 * and commits a baseline PNG under `e2e/fidelity/baseline/module/`. Because
 * `MOD_SCREENS` is a post-snapshot surface with no dc.html region (charter D2
 * RATIFIED 2026-07-09), there is no prototype side — the build-side captures ARE
 * the visual-regression baseline. The same states are also asserted
 * deterministically by `ModuleDemo.test.tsx` (the component-test fidelity
 * registry) — each `selector` below is the `data-fidelity` anchor both the rig
 * and that test key off.
 *
 * The built side is reachable at the standalone dev harness `/console-dev/module`
 * (a live read); `config` selects which proof config drives the state.
 */
export const MODULE_FIDELITY_STATES = [
  {
    id: "list",
    // support config → table body (shared-track list + statbar + search).
    build: { path: "/console-dev/module?config=support" },
    selector: '[data-fidelity="module-list"]',
    demoState: "list",
  },
  {
    id: "detail-open",
    // a row's detail pinned open: kv grid + link chips + primary action.
    build: { path: "/console-dev/module?config=support" },
    selector: '[data-fidelity="module-detail"]',
    demoState: "detail-open",
  },
  {
    id: "lanes",
    // work-order config → kanban body (the generic `lanes` field).
    build: { path: "/console-dev/module?config=workOrder" },
    selector: '[data-fidelity="module-lanes"]',
    demoState: "lanes",
  },
];

export default MODULE_FIDELITY_STATES;
