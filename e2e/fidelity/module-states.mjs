/**
 * Fidelity states for the P0.4 generic module template (charter §3 P0.4, D2.1).
 *
 * The dual-capture rig (`capture.mjs`) screenshots each state and hands the pair
 * (prototype MOD_SCREENS surface vs. built template) to the `visual-verdict`
 * skill. Until the rig grows a `--screen=module` navigator, these states are
 * asserted deterministically by `ModuleDemo.test.tsx` (the component-test
 * fidelity registry, matching the P0.3 composer precedent) — each `selector`
 * below is the `data-fidelity` anchor that test renders.
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
