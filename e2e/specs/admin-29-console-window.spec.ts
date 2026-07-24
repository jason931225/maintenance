import { expect, test, type Page } from "@playwright/test";

import {
  attachVirtualAuthenticator,
  enrollPasskey,
  removeVirtualAuthenticator,
} from "../fixtures/auth";

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

const CARD = '[data-card-id="issues"]';
const HEADER = `${CARD} [data-card-header]`;

async function loginWithDevRole(page: Page): Promise<string> {
  await page.goto("/login");
  const roleSwitcher = page.getByRole("region", { name: "로컬 역할 전환" });
  const sessionResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/dev-auth/session") &&
      response.request().method() === "POST",
  );
  await roleSwitcher
    .getByRole("button", { name: /관리자 로그인$/ })
    .click();
  const session = (await (await sessionResponse).json()) as {
    access_token?: string;
  };
  expect(
    session.access_token,
    "dev-auth response must include an access token",
  ).toBeTruthy();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
  return session.access_token!;
}

/** Start from a clean server layout through the same authenticated API under test. */
async function resetWorkspace(page: Page, accessToken: string) {
  const response = await page.request.put("/api/v1/me/workspace", {
    data: { layout: {} },
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(response.ok()).toBe(true);
}

async function openWindowHarness(page: Page) {
  const harness = page.locator("[data-window-harness]");
  const onboarding = page.getByRole("heading", {
    name: "패스키 등록",
    level: 1,
  });

  await page.goto("/console-dev/window");
  const firstReady = await Promise.any([
    harness
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => "harness" as const),
    onboarding
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => "onboarding" as const),
  ]);

  if (firstReady === "onboarding") {
    await enrollPasskey(page);
    await page.goto("/console-dev/window");
  }
  await expect(harness).toBeVisible({ timeout: 10_000 });
}

test("ADMIN-29 a pinned window survives reload via the server workspace layout", async ({
  page,
}) => {
  const authenticator = await attachVirtualAuthenticator(page);
  try {
    const accessToken = await loginWithDevRole(page);
    await resetWorkspace(page, accessToken);
    await openWindowHarness(page);

    const issues = page.locator(CARD);
    // Clean slate: the card starts laid out in the grid.
    await expect(issues).toHaveAttribute("data-card-state", "grid", {
      timeout: 8_000,
    });

    // Register before the edit so the debounced request cannot win the race.
    const workspaceSaved = page.waitForResponse(
      (response) =>
        response.url().includes("/api/v1/me/workspace") &&
        response.request().method() === "PUT",
    );

    // Pin it via a header double-click inside the 54px drag band.
    await page.locator(HEADER).dblclick({ position: { x: 40, y: 8 } });
    await expect(issues).toHaveAttribute("data-card-state", "pin-split");

    // Prove the debounced save reached the server, discard browser-local state,
    // then hard-reload so restoration can only come from the workspace GET.
    expect((await workspaceSaved).ok()).toBe(true);
    await page.evaluate(() =>
      window.localStorage.removeItem("oyatie.console.window.layout"),
    );
    await page.reload();
    await expect(page.locator("[data-window-harness]")).toBeVisible({
      timeout: 10_000,
    });

    // Restored from the server layout — not localStorage.
    await expect(page.locator(CARD)).toHaveAttribute(
      "data-card-state",
      "pin-split",
      {
        timeout: 8_000,
      },
    );
  } finally {
    await removeVirtualAuthenticator(authenticator);
  }
});
