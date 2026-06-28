import { test, expect } from "../fixtures/roles";
import { navigateByHref } from "../fixtures/ux";

/**
 * MECH-11 — mechanic opens a messenger thread and sends a message.
 *
 * Prerequisite: seed-mech.sql seeds a 'group' thread titled "E2E 정비팀 대화"
 * with the mechanic as OWNER and the admin as MEMBER.
 */

test("MECH-11 mechanic opens a thread and sends a message", async ({
  page,
  loginAs,
}) => {
  await loginAs("MECHANIC");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  await navigateByHref(page, "/messenger");
  await expect(
    page.getByRole("heading", { name: /메신저/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // The seeded group thread should appear in the thread list.
  const threadBtn = page
    .getByRole("button", { name: /E2E 정비팀 대화/ })
    .first();
  await expect(threadBtn).toBeVisible({ timeout: 8_000 });

  // Open the thread.
  await threadBtn.click();

  // The message input (composer) should appear.
  const composer = page.getByRole("textbox", { name: /메시지 입력/ });
  await expect(composer).toBeVisible({ timeout: 5_000 });

  // Type and send a message.
  await composer.fill("E2E 테스트 메시지입니다.");
  await page.getByRole("button", { name: /^전송$/ }).click();

  // The sent message body should appear in the thread.
  await expect(
    page.getByText(/E2E 테스트 메시지입니다\./).first(),
  ).toBeVisible({ timeout: 8_000 });
});
