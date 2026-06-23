import { test, expect } from "../fixtures/roles";
import type { Page } from "@playwright/test";

/**
 * AUTH-06b — passkey self-service UI (SecurityPanel on the ProfilePage).
 *
 * AUTH-06 exercises the passkey-management API directly via fetch; this spec is
 * the BROWSER-DOM counterpart: it drives the actual SecurityPanel widget a user
 * sees on /settings/profile, asserting on rendered DOM (visible text + button
 * state), never a raw fetch. Korean strings mirror web/src/i18n/ko.ts > security.
 *
 * After the role ceremony the user holds exactly ONE passkey, so this spec
 * verifies the security-critical LAST-PASSKEY DELETE GUARD in the UI:
 *   1. the enrolled credential is LISTED (registration timestamp row),
 *   2. its 삭제 (delete) button is DISABLED and carries the lockout-guard title,
 *   3. the guard explanation paragraph renders,
 *   4. clicking the disabled 삭제 does NOT open the confirm dialog (the guard
 *      cannot be bypassed from the UI) — so the user can never lock themselves
 *      out by deleting their only passkey.
 */

const SEC = {
  registered: "등록일",
  revoke: "삭제",
  confirmTitle: "이 패스키를 삭제하시겠습니까?",
  lastPasskey: "마지막 패스키는 삭제할 수 없습니다. 먼저 다른 패스키를 등록하세요.",
} as const;

/** Locator for the destructive 삭제 (revoke) buttons inside the passkey list. */
function revokeButtons(page: Page) {
  return page.getByRole("button", { name: new RegExp(`^${SEC.revoke}$`) });
}

/** Passkey list rows (each list item carries the 등록일 timestamp). */
function passkeyRows(page: Page) {
  return page.locator("li").filter({ hasText: new RegExp(SEC.registered) });
}

test("AUTH-06b SecurityPanel lists the passkey and guards the last-passkey delete in the DOM", async ({
  page,
  loginAs,
}) => {
  // The role ceremony enrolls exactly one discoverable passkey for the user.
  await loginAs("ADMIN");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  // ── The SecurityPanel lives on the profile page. ──────────────────────────────
  await page.goto("/settings/profile");
  // The SecurityPanel h2 is "보안 (패스키)"; match the stable 보안 prefix (the
  // literal parens would otherwise be parsed as a regex group).
  await expect(
    page.getByRole("heading", { name: /보안/ }),
  ).toBeVisible({ timeout: 10_000 });

  // (1) Exactly one passkey is listed (the one enrolled by the ceremony).
  await expect(passkeyRows(page)).toHaveCount(1, { timeout: 10_000 });

  // (2) The single passkey's 삭제 button is DISABLED (last-passkey guard) and
  // carries the lockout-guard message as its accessible title.
  const deleteButton = revokeButtons(page).first();
  await expect(deleteButton).toBeVisible();
  await expect(deleteButton).toBeDisabled();
  await expect(deleteButton).toHaveAttribute("title", SEC.lastPasskey);

  // (3) The guard explanation paragraph renders beneath the list.
  await expect(page.getByText(SEC.lastPasskey).first()).toBeVisible();

  // (4) Clicking the disabled 삭제 must NOT open the confirm dialog — the guard
  // cannot be bypassed from the UI, so the user can never delete their only
  // passkey and lock themselves out.
  await deleteButton.click({ force: true });
  await expect(
    page.getByRole("dialog", { name: SEC.confirmTitle }),
  ).toHaveCount(0);
});
