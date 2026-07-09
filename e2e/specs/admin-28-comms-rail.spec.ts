import {
  test,
  expect,
  sql,
  loginAsLanding,
  ROLE_CONFIG,
  TENANT_ORG_ID,
} from "../fixtures/roles";
import { navigateByHref } from "../fixtures/ux";

const ADMIN_USER_ID = ROLE_CONFIG.ADMIN.userId;

// Mirrors ko.shell.commsRail (web/src/i18n/ko.ts) — e2e specs hardcode UI
// strings rather than importing across packages.
const RAIL = {
  label: "커뮤니케이션",
  openNotifications: "알림 열기",
  sectionNotifications: "알림",
  sectionMessenger: "메신저",
  markAllRead: "모두 읽음",
} as const;

/**
 * ADMIN-28 — the comms rail (UI-M2b) is present on every console screen, hosts
 * the notification centre, and its messenger section steps aside when the
 * messenger page owns the screen (promotion).
 *
 * Live realtime WS delivery is covered deterministically by the realtimeHub +
 * comms store vitest suites (mocked socket); this browser spec asserts the
 * user-visible rail surface, the topbar bell → rail wiring, mark-all
 * persistence when unread notifications exist, and promotion.
 */
test("ADMIN-28 comms rail hosts notifications and yields the messenger section on promotion", async ({
  page,
}) => {
  // Seed exactly one unread notification so the mark-all path always runs
  // (link shape mirrors the domain's serde: {type,screen}).
  sql(`DELETE FROM notifications WHERE recipient_user_id = '${ADMIN_USER_ID}'`);
  sql(
    `INSERT INTO notifications (org_id, recipient_user_id, category, body, link, unread) ` +
      `VALUES ('${TENANT_ORG_ID}', '${ADMIN_USER_ID}', '결재', 'E2E 미확인 알림', ` +
      `'{"type":"screen","screen":"approvals"}'::jsonb, true)`,
  );

  // loginAs (the fixture) deliberately lands on /dispatch for legacy
  // dispatch-oriented specs; this spec asserts rail behavior on the real
  // authenticated landing route, so it drives the ceremony via
  // loginAsLanding directly (same pattern as admin-21/22/23/24).
  await loginAsLanding(page, "ADMIN");
  await expect(page).toHaveURL(/\/work-hub/, { timeout: 15_000 });

  const rail = page.getByRole("complementary", { name: RAIL.label });
  await expect(rail).toBeVisible({ timeout: 10_000 });

  // The topbar bell opens/expands the rail to the notifications section.
  await page
    .getByRole("banner")
    .getByRole("button", { name: RAIL.openNotifications })
    .click();

  const notificationsHeader = rail.getByRole("button", {
    name: new RegExp(RAIL.sectionNotifications),
  });
  await expect(notificationsHeader).toBeVisible({ timeout: 5_000 });

  // Mark-all persistence — the seeded unread guarantees this always runs.
  const markAll = rail.getByRole("button", { name: RAIL.markAllRead });
  await expect(markAll).toBeVisible({ timeout: 5_000 });
  await markAll.click();
  await expect(markAll).toBeHidden({ timeout: 5_000 });
  await page.reload();
  await page
    .getByRole("banner")
    .getByRole("button", { name: RAIL.openNotifications })
    .click();
  await expect(
    rail.getByRole("button", { name: RAIL.markAllRead }),
  ).toBeHidden({ timeout: 5_000 });

  // Promotion: opening the messenger page hides the rail's messenger section.
  await navigateByHref(page, "/messenger");
  await expect(
    page.getByRole("heading", { name: /메신저/, level: 1 }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    rail.getByRole("button", {
      name: new RegExp(RAIL.sectionMessenger),
    }),
  ).toHaveCount(0);
});
