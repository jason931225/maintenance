import { test, expect } from "../fixtures/roles";
import { attachConsoleGuard, auditPage } from "../fixtures/ux";

/**
 * EXEC-01 — the EXECUTIVE reads the KPI dashboard on /kpi.
 *
 * KpiRead is `[D, D, A, A, A]` (RECP/MECH denied; ADMIN/EXEC/SADMIN allowed), so
 * an executive is a first-class KPI consumer. The metric cards rendering is the
 * proof the Period report deserialized (the rfc3339 serde guard) under a real
 * executive session — not just an admin one.
 *
 * UX layer: zero critical/serious axe violations, no console errors, no raw i18n
 * keys, and the loading→loaded state transition is observed.
 */

test("EXEC-01 executive reads the KPI dashboard with metric cards", async ({
  page,
  loginAs,
}) => {
  const consoleGuard = attachConsoleGuard(page);

  await loginAs("EXECUTIVE");
  await page.goto("/kpi");
  await expect(
    page.getByRole("heading", { name: /임원 KPI 대시보드/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // The period field is present and pre-filled with the default range.
  await expect(page.getByLabel("기간").first()).toBeVisible();

  // The §4-11 stat strip drill links prove the report deserialized for an
  // executive session (every metric renders as "<label> <value> 상세 열기").
  await expect(
    page.getByRole("link", { name: /완료 건수.*상세 열기/ }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByRole("link", { name: /평균 응답 속도.*상세 열기/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /P1 수락률.*상세 열기/ }),
  ).toBeVisible();

  await auditPage(page, { context: "/kpi (executive)", consoleGuard });
});
