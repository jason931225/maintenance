import { test, expect } from "../fixtures/roles";
import { attachConsoleGuard, auditPage } from "../fixtures/ux";

/**
 * VISUAL-42 — console ↔ public-web design-language unification (#42).
 *
 * Captures full-page screenshots of four representative console surfaces after
 * the KNL token re-skin (ink/signal/brand-teal/steel/line/muted-panel), so they
 * can be reviewed side-by-side against the redesigned public landing
 * (knllogistic.com) for a seamless palette/typography read. Each capture also
 * runs the shared UX audit (zero critical/serious axe violations + no console
 * errors), so the re-skin is verified to keep contrast/focus/landmarks intact —
 * not just to look the part.
 *
 * Surfaces: dispatch board (dense table), intake (form), KPI dashboard
 * (dashboard cards), and the users admin (dense list). Artifacts land under
 * e2e/.artifacts/ (gitignored, runtime-only).
 */

const ARTIFACTS = "e2e/.artifacts";

test("VISUAL-42 captures the re-skinned console surfaces (dispatch / form / KPI / list)", async ({
  page,
  loginAs,
}) => {
  const guard = attachConsoleGuard(page);
  await loginAs("SUPER_ADMIN");

  // 1) Dispatch board — dense work-order table, the console default route.
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({
    timeout: 8_000,
  });
  await page.screenshot({
    path: `${ARTIFACTS}/console-01-dispatch.png`,
    fullPage: true,
  });
  await auditPage(page, { context: "dispatch" });

  // 2) Intake — a form page (inputs/selects/textarea re-skinned).
  await page.goto("/intake");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({
    timeout: 8_000,
  });
  await page.screenshot({
    path: `${ARTIFACTS}/console-02-intake-form.png`,
    fullPage: true,
  });
  await auditPage(page, { context: "intake" });

  // 3) KPI dashboard — metric cards + period control.
  await page.goto("/kpi");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({
    timeout: 8_000,
  });
  await page.screenshot({
    path: `${ARTIFACTS}/console-03-kpi-dashboard.png`,
    fullPage: true,
  });
  await auditPage(page, { context: "kpi" });

  // 4) Users admin — a dense list/table page.
  await page.goto("/settings/users");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({
    timeout: 8_000,
  });
  await page.screenshot({
    path: `${ARTIFACTS}/console-04-users-list.png`,
    fullPage: true,
  });
  await auditPage(page, { context: "users" });

  guard.assertClean();
});
