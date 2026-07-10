/**
 * Fidelity states for the P0.4 generic module template (charter §3 P0.4, D2.1).
 *
 * `capture.mjs --screen=module` navigates the BUILD side to the asset module
 * screen states below and commits baseline PNGs under
 * `e2e/fidelity/baseline/module/`. Because `MOD_SCREENS` is a post-snapshot
 * surface with no dc.html region (charter D2 RATIFIED 2026-07-09), there is no
 * prototype side — the build-side captures ARE the visual-regression baseline
 * until a later dc.html sync delivers the module surface.
 *
 * The built side is reachable through the shipping console route
 * `/console?screen=asset`; Playwright stubs the source-object APIs in
 * `module-fixtures.mjs` so this remains a visual-only capture.
 */
export const MODULE_FIDELITY_STATES = [
  {
    id: "list",
    // asset config → table body (shared-track list + statbar + search).
    build: { path: "/console?screen=asset" },
    selector: '[data-fidelity="module-list"]',
    demoState: "list",
  },
  {
    id: "detail-open",
    // first asset row's detail loaded: kv grid + link chips + primary action.
    build: { path: "/console?screen=asset" },
    selector: '[data-fidelity="module-detail"]',
    demoState: "detail-open",
  },
];

export default MODULE_FIDELITY_STATES;
