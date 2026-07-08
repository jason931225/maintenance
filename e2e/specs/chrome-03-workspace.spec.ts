import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import {
  attachVirtualAuthenticator,
  enrollPasskey,
  removeVirtualAuthenticator,
} from "../fixtures/auth";

/**
 * UI-M1b ConsoleShell window-grammar guard.
 *
 * Runs only under the `dev-auth` Playwright project (`MNT_DEV_AUTH_E2E=1`) — it
 * needs the authenticated ConsoleShell and a seeded backend with at least one
 * pinnable /work-hub row. The default preview-only `chromium` project ignores
 * this file. CI-only, like chrome-01/02.
 *
 * Proves the AC: pin a real object on /work-hub, pop out and drag/snap it,
 * switch to /attendance and back (panel survives — mounted persistence, no
 * reload), reload (layout restored from the server profile), minimize to tray
 * and restore, Esc closes; axe clean.
 */
async function loginWithDevRole(page: Page): Promise<string> {
  await page.goto("/login");
  await page.getByRole("button", { name: /역할 전환 로그인/ }).click();
  const sessionResponse = page.waitForResponse(
    (res) =>
      res.url().includes("/api/v1/dev-auth/session") &&
      res.request().method() === "POST",
  );
  await page.getByRole("button", { name: "역할로 로그인" }).click();
  const session = (await (await sessionResponse).json()) as {
    access_token?: string;
  };
  expect(
    session.access_token,
    "dev-auth response must include an access token",
  ).toBeTruthy();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
  await expect(
    page.getByRole("navigation", { name: "메인 내비게이션" }),
  ).toBeVisible();
  return session.access_token!;
}

function nav(page: Page) {
  return page.getByRole("navigation", { name: "메인 내비게이션" });
}

async function resetWorkspace(page: Page, accessToken: string) {
  const res = await page.request.put("/api/v1/me/workspace", {
    data: { layout: { v: 1, panels: [] } },
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(res.ok()).toBe(true);
}

async function seedPinnedSupportTicket(page: Page): Promise<string> {
  const title = `Workspace window grammar seed ${Date.now()}`;
  const res = await page.request.post("/api/v1/support/intake", {
    data: {
      category: "OPERATIONAL",
      priority: "URGENT",
      title,
      body: "Seeded by chrome-03-workspace to guarantee a real pinnable Work Hub row.",
      requester_name: "Workspace E2E",
      requester_contact: "workspace-e2e@example.invalid",
    },
  });
  expect(res.ok()).toBe(true);
  return title;
}

async function dragHeaderTo(page: Page, x: number, y: number) {
  const box = await page
    .getByTestId("workspace-pin-panel-header")
    .first()
    .boundingBox();
  if (!box) {
    throw new Error("workspace pin panel header must be visible before drag");
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 4 });
  await page.mouse.up();
}

async function completePasskeySetupIfNeeded(page: Page) {
  const onboardingTitle = page.getByRole("heading", {
    name: "패스키 등록",
    level: 1,
  });
  const workHubTitle = page.getByRole("heading", {
    name: "업무 허브",
    level: 1,
  });
  const firstReady = await Promise.race([
    onboardingTitle
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => "onboarding" as const)
      .catch(() => undefined),
    workHubTitle
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => "work-hub" as const)
      .catch(() => undefined),
  ]);
  if (firstReady === "onboarding") {
    await enrollPasskey(page);
  }
}

test("window grammar: pin survives screen switch + reload, tray restore, Esc", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const authenticator = await attachVirtualAuthenticator(page);
  try {
    const accessToken = await loginWithDevRole(page);
    await resetWorkspace(page, accessToken);
    const supportTicketTitle = await seedPinnedSupportTicket(page);

    // Use a hard navigation here on purpose: the later reload assertion needs a
    // durable refresh-cookie session. A fresh dev-auth persona has no passkey,
    // so the first hard navigation can correctly route through onboarding.
    await page.goto("/work-hub");
    await completePasskeySetupIfNeeded(page);
    await expect(
      page.getByRole("heading", { name: "업무 허브", level: 1 }),
    ).toBeVisible();

    // Pin the seeded real row into a detail panel.
    await expect(
      page.getByRole("heading", { name: supportTicketTitle, exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    const pinButton = page.getByRole("button", {
      name: `${supportTicketTitle} 상세 고정`,
    });
    await expect(pinButton).toBeVisible();
    const savePut = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/me/workspace") &&
        r.request().method() === "PUT",
    );
    await pinButton.click();
    await expect(page.getByRole("button", { name: "최소화" })).toBeVisible();
    await savePut; // debounced layout save reached the server before we reload

    // Pop out, drag into a snap zone, and drop back to a pinned quadrant.
    await page.getByRole("button", { name: "창으로 분리" }).click();
    await expect(page.getByTestId("workspace-pin-panel")).toBeVisible();
    await dragHeaderTo(page, 180, 180);
    await expect(
      page.getByRole("button", { name: "창으로 분리" }),
    ).toBeVisible();

    // Switch to /attendance and back — the panel survives with no server round-trip.
    await nav(page)
      .getByRole("link", { name: "근태 기록", exact: true })
      .click();
    await expect(page).toHaveURL(/\/attendance/);
    await nav(page)
      .getByRole("link", { name: "업무 허브", exact: true })
      .click();
    await expect(page).toHaveURL(/\/work-hub/);
    await expect(page.getByRole("button", { name: "최소화" })).toBeVisible();

    // Reload — the layout is restored from the server profile.
    await page.reload();
    await expect(page.getByRole("button", { name: "최소화" })).toBeVisible({
      timeout: 15_000,
    });

    // Minimize to the tray, then restore.
    await page.getByRole("button", { name: "최소화" }).click();
    const restore = page.getByRole("button", { name: /복원$/ });
    await expect(restore).toBeVisible();
    await expect(page.getByRole("button", { name: "최소화" })).toHaveCount(0);
    await restore.click();
    await expect(page.getByRole("button", { name: "최소화" })).toBeVisible();

    // Esc cascades the open panel to the tray.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "최소화" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /복원$/ })).toBeVisible();

    // Axe on the workspace with a pinned panel restored.
    await page.getByRole("button", { name: /복원$/ }).click();
    await expect(page.getByRole("button", { name: "최소화" })).toBeVisible();
    const results = await new AxeBuilder({ page })
      .include("#main-content")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      results.violations,
      results.violations
        .map((v) => `[${v.impact ?? "?"}] ${v.id}: ${v.help}`)
        .join("\n"),
    ).toEqual([]);
  } finally {
    await removeVirtualAuthenticator(authenticator);
  }
});
