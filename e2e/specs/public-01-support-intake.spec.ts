import { test, expect } from "../fixtures/auth";

/**
 * PUBLIC-01 — unauthenticated customer support intake (#6 KNL storefront).
 *
 * As a public visitor (no login, no passkey), open /support/new
 * (CustomerIntakePage, nested in PublicLayout), fill the comprehensive intake
 * form, submit (POST /api/v1/support/intake — public, token-less, rate-limited),
 * and assert the branded confirmation state (the role="status" h2
 * "접수가 완료되었습니다." + the follow-up detail).
 *
 * Uses the auth fixture purely for its cold-start DB reset + per-test device id
 * (which isolates the intake rate-limit bucket); the flow itself is fully
 * unauthenticated — no ceremony runs.
 */

test("PUBLIC-01 visitor submits the public intake form and sees the confirmation", async ({
  page,
}) => {
  // No login. Land directly on the public intake page.
  await page.goto("/support/new");

  // The branded intake page renders inside PublicLayout (h1 == intake title).
  await expect(
    page.getByRole("heading", { name: "정비·장비 온라인 접수", level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // The PublicLayout header is present (this is a storefront page, not the
  // authenticated console) — the staff 로그인 link and the FSM 플랫폼 nav render.
  await expect(
    page.getByRole("link", { name: "FSM 플랫폼" }).first(),
  ).toHaveAttribute("href", "/platform-fsm");

  // ── Comprehensive intake form ───────────────────────────────────────────────
  // Category + priority selects (customer-facing plain-language options). These
  // ids are unique to the form.
  await page.locator("#intake-category").selectOption("COMPLAINT");
  await page.locator("#intake-priority").selectOption("HIGH");

  // Required free-text fields (title / body / requester name / contact).
  // The page intro h1 shares the DOM id "intake-title" with the form's title
  // input, which (a) makes a bare #intake-title locator ambiguous and (b) breaks
  // the title input's label association so its accessible name falls back to the
  // placeholder. Disambiguate the title by tag (input#intake-title); the other
  // three fields have unambiguous label-derived accessible names.
  await page
    .locator("input#intake-title")
    .fill("290호기 시동 불량 — E2E 공개 접수");
  await page
    .getByRole("textbox", { name: "내용" })
    .fill(
      "전동 지게차가 현장에서 시동이 걸리지 않습니다. 모델 E2E모델-15T, 창원 성산구 현장. 운행 중단 상태입니다.",
    );
  await page.getByRole("textbox", { name: "이름" }).fill("E2E 방문 고객");
  await page.getByRole("textbox", { name: "연락처" }).fill("010-2625-0987");

  await page.screenshot({
    path: "e2e/.artifacts/public-intake-form.png",
    fullPage: true,
  });

  // ── Submit (POST /api/v1/support/intake) ────────────────────────────────────
  await page.getByRole("button", { name: "티켓 등록" }).click();

  // ── Branded confirmation state ──────────────────────────────────────────────
  // The page swaps the form for the acknowledgement (role="status" heading).
  await expect(
    page.getByRole("status").filter({ hasText: "접수가 완료되었습니다." }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByText(/담당자가 확인 후 빠르게 연락드리겠습니다/),
  ).toBeVisible();
  // The "새 접수 작성" reset CTA is offered.
  await expect(
    page.getByRole("button", { name: "새 접수 작성" }),
  ).toBeVisible();

  await page.screenshot({
    path: "e2e/.artifacts/public-intake-confirmed.png",
    fullPage: true,
  });
});
