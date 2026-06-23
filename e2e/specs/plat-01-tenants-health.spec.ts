import {
  test,
  expect,
  COLDSTART_OTP,
  redeemOtp,
  enrollPasskey,
} from "../fixtures/auth";
import { attachConsoleGuard, auditPage } from "../fixtures/ux";

/**
 * PLAT-01 — the PLATFORM admin lists tenants and reads cross-tenant health.
 *
 * The cold-start admin is a PLATFORM-tier SUPER_ADMIN (sentinel org). After the
 * real OTP→onboard→enroll ceremony it lands in the platform console
 * (/platform/tenants). GET /api/platform/orgs returns a bare array of tenants with
 * rfc3339 `created_at`; GET /api/platform/ops returns the cross-tenant health rollup.
 *
 * This is the spec that proves the platform DTO serde fix: a tenant row's 생성일
 * (created_at) renders as a real ko-KR date, NOT "Invalid Date" (which is what an
 * array-shaped timestamp produced through `new Date([...])`).
 */

async function loginPlatform(page: import("@playwright/test").Page) {
  await redeemOtp(page, COLDSTART_OTP);
  await enrollPasskey(page);
  await expect(page).toHaveURL(/\/platform/, { timeout: 15_000 });
}

test("PLAT-01 platform admin lists tenants with a valid created date", async ({
  page,
}) => {
  const consoleGuard = attachConsoleGuard(page);

  await loginPlatform(page);
  await page.goto("/platform/tenants");
  await expect(
    page.getByRole("heading", { name: /테넌트 관리/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // The migration-seeded KNL tenant renders in the list.
  const knlCell = page.getByRole("cell", { name: "KNL Logistics" });
  await expect(knlCell).toBeVisible({ timeout: 8_000 });
  // Its slug + status badge render. `exact` so the slug cell ("knl") is not also
  // matched by the name cell ("KNL Logistics").
  await expect(
    page.getByRole("cell", { name: "knl", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/활성/).first()).toBeVisible();

  // The 생성일 cell must be a real localized date — NOT "Invalid Date" (the symptom
  // of an array-shaped `created_at` reaching `new Date([...])`). The serde rfc3339
  // fix on the platform DTO is what makes this render correctly.
  await expect(page.getByText(/Invalid Date/)).toHaveCount(0);
  const knlRow = page.getByRole("row").filter({ has: knlCell });
  await expect(knlRow.getByText(/\d{4}/)).toBeVisible();

  await auditPage(page, { context: "/platform/tenants", consoleGuard });
});

test("PLAT-01 platform admin reads the cross-tenant ops health rollup", async ({
  page,
}) => {
  const consoleGuard = attachConsoleGuard(page);

  await loginPlatform(page);
  await page.goto("/platform/ops");
  await expect(
    page.getByRole("heading", { name: /플랫폼 운영 현황/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // KNL's health row renders with its slug + numeric counts.
  await expect(page.getByText("KNL Logistics")).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText("knl").first()).toBeVisible();

  await auditPage(page, { context: "/platform/ops", consoleGuard });
});
