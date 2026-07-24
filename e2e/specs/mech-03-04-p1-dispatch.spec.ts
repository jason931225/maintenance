import { test, expect, querySql, sql } from "../fixtures/roles";

/**
 * MECH-03 — mechanic accepts a P1 dispatch offer.
 * MECH-04 — mechanic declines a P1 dispatch offer.
 *
 * The seeded P1 dispatch (…d10001, BROADCASTING, work order …f00002) is reset
 * before each spec so both tests can use the same dispatch ID. A mechanic sees
 * an authenticated, person-scoped offer queue—not a manager's dispatch-ID lookup.
 */

const ORG_ID = "00000000-0000-0000-0000-0000000000a1";
const DISPATCH_ID = "00000000-0000-0000-0000-000000d10001";
const MECH_ID = "00000000-0000-0000-0000-0000000d0002";
const P1_OFFER_REQUEST_NUMBER = /\d{8}-012$/;

/** Reset the P1 dispatch back to BROADCASTING and clear any existing response. */
function resetP1Dispatch() {
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     UPDATE p1_dispatches
       SET status = 'BROADCASTING',
           auto_assigned_mechanic_id = NULL,
           accept_window_ends_at = now() + interval '2 hours',
           updated_at = now()
     WHERE id = '${DISPATCH_ID}';
     DELETE FROM p1_dispatch_responses
     WHERE dispatch_id = '${DISPATCH_ID}';
     COMMIT;`,
  );
}

function responseForMechanic(): string | undefined {
  return querySql<{ response: string }>(`
    SELECT response
    FROM p1_dispatch_responses
    WHERE dispatch_id = '${DISPATCH_ID}'
      AND user_id = '${MECH_ID}'
      AND org_id = '${ORG_ID}'
  `)[0]?.response;
}

test.beforeEach(() => {
  resetP1Dispatch();
});

test("MECH-03 mechanic accepts a P1 dispatch offer", async ({
  page,
  loginAs,
}) => {
  await loginAs("MECHANIC");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  // Offers are loaded for the authenticated mechanic from /api/v1/me/dispatch-offers.
  const offerQueue = page.getByLabel("P1 배차 대기 목록");
  await expect(offerQueue).toBeVisible();
  const offer = offerQueue
    .getByRole("link", { name: P1_OFFER_REQUEST_NUMBER })
    .locator("xpath=ancestor::div[.//button][1]");
  await expect(offer).toBeVisible({ timeout: 8_000 });
  await expect(offer.getByText("수락 대기", { exact: true })).toBeVisible();

  await offer.getByRole("button", { name: "수락", exact: true }).click();

  await expect(
    page.getByRole("status").filter({ hasText: /^배차를 수락했습니다\.$/ }),
  ).toHaveText("배차를 수락했습니다.");
  await expect(
    offerQueue.getByRole("link", { name: P1_OFFER_REQUEST_NUMBER }),
  ).not.toBeVisible();
  await expect.poll(responseForMechanic).toBe("ACCEPT");
});

test("MECH-04 mechanic declines a P1 dispatch offer", async ({
  page,
  loginAs,
}) => {
  await loginAs("MECHANIC");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  const offerQueue = page.getByLabel("P1 배차 대기 목록");
  await expect(offerQueue).toBeVisible();
  const offer = offerQueue
    .getByRole("link", { name: P1_OFFER_REQUEST_NUMBER })
    .locator("xpath=ancestor::div[.//button][1]");
  await expect(offer).toBeVisible({ timeout: 8_000 });
  await expect(offer.getByText("수락 대기", { exact: true })).toBeVisible();

  await offer.getByRole("button", { name: "거절", exact: true }).click();

  await expect(
    page.getByRole("status").filter({ hasText: /^배차를 거절했습니다\.$/ }),
  ).toHaveText("배차를 거절했습니다.");
  await expect(
    offerQueue.getByRole("link", { name: P1_OFFER_REQUEST_NUMBER }),
  ).not.toBeVisible();
  await expect.poll(responseForMechanic).toBe("DECLINE");
});
