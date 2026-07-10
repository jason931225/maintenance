import { test, expect, sql, TENANT_ORG_ID } from "../fixtures/roles";

/**
 * ADMIN-29 — carbon-copy window/pin engine (charter P0.2) persistence.
 *
 * Proves the four-state window grammar survives a full reload via the REAL
 * per-user server layout endpoint (GET/PUT /api/v1/me/workspace), not
 * localStorage: pin a card, wait for the debounced save, reload, and the pin is
 * restored from the server. The dev-only capture harness (/console-dev/window)
 * mounts the standalone primitive so this exercises the engine in isolation
 * before it is wired into a screen in a later slice.
 *
 * The unit + component suites (web/src/console/window/*) already cover the drag
 * threshold, dblclick-pin padding reservation, tray, and non-interactive guard;
 * this spec is specifically the wired round-trip through the real backend.
 */

const ADMIN_USER = "00000000-0000-0000-0000-0000000d0003";
const CARD = '[data-card-id="issues"]';
const HEADER = `${CARD} [data-card-header]`;

/** Start from a clean server layout so the assertion is deterministic. */
function resetWorkspace() {
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${TENANT_ORG_ID}', true);
     DELETE FROM me_workspace_layouts WHERE user_id = '${ADMIN_USER}' AND org_id = '${TENANT_ORG_ID}';
     COMMIT;`,
  );
}

test.beforeEach(() => {
  resetWorkspace();
});

test.afterEach(() => {
  resetWorkspace();
});

test("ADMIN-29 a pinned window survives reload via the server workspace layout", async ({
  page,
  loginAs,
}) => {
  await loginAs("ADMIN");
  await page.goto("/console-dev/window");
  await expect(page.locator("[data-window-harness]")).toBeVisible({ timeout: 10_000 });

  const issues = page.locator(CARD);
  // Clean slate: the card starts laid out in the grid.
  await expect(issues).toHaveAttribute("data-card-state", "grid", { timeout: 8_000 });

  // Pin it via a header double-click inside the 54px drag band.
  await page.locator(HEADER).dblclick({ position: { x: 40, y: 8 } });
  await expect(issues).toHaveAttribute("data-card-state", "pin-split");

  // Let the debounced PUT /api/v1/me/workspace flush, then hard-reload.
  await page.waitForTimeout(1_200);
  await page.reload();
  await expect(page.locator("[data-window-harness]")).toBeVisible({ timeout: 10_000 });

  // Restored from the server layout — not localStorage.
  await expect(page.locator(CARD)).toHaveAttribute("data-card-state", "pin-split", {
    timeout: 8_000,
  });
});
