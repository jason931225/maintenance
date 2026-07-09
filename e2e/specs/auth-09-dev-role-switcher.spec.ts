import { test, expect } from "@playwright/test";

/**
 * AUTH-09 — local dev-auth role switcher.
 *
 * Proves the W3 replacement for the deleted dev-preview fixture mode end to
 * end: the switcher on /login mints a role/org session against the REAL
 * backend (built with `--features dev-auth`, the default for the host
 * `bacon` job — see backend/bacon.toml), and a page that used to fall back to
 * hardcoded fixture rows on a failed/absent API response (Leave Management)
 * now has no such branch at all — it must render the real (here: empty,
 * since a fresh dev-auth persona has no HR records) API result instead.
 *
 * Runs against `node scripts/dev-up.mjs up` (backend + web on the host, real
 * Postgres in the deps containers) — NOT the WebAuthn cold-start e2e harness,
 * which dev-auth deliberately bypasses.
 */
test("role switcher mints a real session and pages render real (non-fixture) data", async ({
  page,
}) => {
  await page.goto("/login");

  // The switcher is a DEV-only affordance, collapsed behind a reveal button —
  // same predicate the deleted dev-preview.ts used (DEV build + localhost).
  await page.getByRole("button", { name: /역할 전환 로그인/ }).click();

  // Default role (SUPER_ADMIN) + the prefilled KNL org id are enough:
  // SUPER_ADMIN gets org-wide BranchScope::All server-side, so no branch_id
  // is required to see something real.
  await page.getByRole("button", { name: "역할로 로그인" }).click();

  // A real signed session was accepted -> navigated off /login into the app.
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });

  // Leave Management used to fall back to hardcoded fixture rows
  // (김현장/박배차, see the deleted web/src/lib/dev-preview.ts) whenever the
  // real API call failed. That branch is gone entirely now, so a genuine
  // (here: empty) API response must render instead — never the old fixture
  // names, and never the load-failed error state.
  //
  // In-app (SPA) navigation, not `page.goto` — a hard reload re-triggers the
  // boot-time silent refresh, which correctly recomputes
  // `requires_passkey_setup` from the DB for this dev-auth persona (it has no
  // real passkey, exactly like a real never-enrolled employee) and forces
  // onboarding. That is real backend behavior working as intended, not
  // something this switcher should route around.
  await page.getByRole("link", { name: "연차관리" }).click();
  await expect(page.getByRole("heading", { name: "연차관리" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByText("연차관리 데이터를 불러오지 못했습니다."),
  ).toHaveCount(0);
  await expect(page.getByText("김현장")).toHaveCount(0);
  await expect(page.getByText("박배차")).toHaveCount(0);
});
