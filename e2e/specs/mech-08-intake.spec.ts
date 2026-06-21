import { test, expect } from "../fixtures/roles";

/**
 * MECH-08 — mechanic creates a work order via the intake (접수증) form.
 *
 * Validates:
 *  - Required-field error markers when submitting empty form.
 *  - 호기 (#E2E-001) input triggers model autopull (EquipmentLookupPanel).
 *  - Successful intake creation shows "접수가 저장되었습니다."
 *
 * Prerequisite: seed-mech.sql seeds registry_equipment with management_no
 * '#E2E-001' and model 'E2E모델-15T'.
 */

test("MECH-08 intake form: required-field errors, 호기 autopull, then submit", async ({
  page,
  loginAs,
}) => {
  await loginAs("MECHANIC");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  // Navigate to the intake page.
  await page.goto("/intake");
  await expect(
    page.getByRole("heading", { name: /접수 입력/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // ── Required-field validation ──────────────────────────────────────────────
  // Submit without filling anything → both required fields should flag errors.
  await page.getByRole("button", { name: /접수 저장/ }).click();
  await expect(page.getByText(/호기를 입력하세요\./).first()).toBeVisible();
  await expect(page.getByText(/고장내용을 입력하세요\./).first()).toBeVisible();
  await expect(
    page.getByText(/정비문의 연락처를 입력하세요\./).first(),
  ).toBeVisible();

  // ── 호기 autopull ──────────────────────────────────────────────────────────
  // Type the management_no; the debounce fires after ~300ms.
  await page.getByRole("textbox", { name: /호기/ }).fill("#E2E-001");
  // Wait for the equipment lookup panel to show the model.
  await expect(page.getByText(/E2E모델-15T/).first()).toBeVisible({
    timeout: 5_000,
  });
  // Equipment details (customer, site) are rendered in the lookup panel.
  await expect(page.getByText(/E2E고객사/).first()).toBeVisible();

  // ── Fill remaining required fields ────────────────────────────────────────
  await page
    .getByRole("textbox", { name: /고장내용/ })
    .fill("엔진 시동 불가 — E2E 테스트");
  await page
    .getByRole("textbox", { name: /정비문의/ })
    .fill("010-2625-0987");

  // Evidence: the intake form with required-field markers, 요청일자, 정비문의,
  // and the 호기 autopull populated.
  await page.screenshot({
    path: "e2e/.artifacts/intake-form.png",
    fullPage: true,
  });

  // ── Submit ─────────────────────────────────────────────────────────────────
  await page.getByRole("button", { name: /접수 저장/ }).click();

  // Success status message.
  await expect(
    page.getByText(/접수가 저장되었습니다\./).first(),
  ).toBeVisible({ timeout: 10_000 });
});
