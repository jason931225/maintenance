import { test, expect } from "../fixtures/roles";
import { attachConsoleGuard, auditPage } from "../fixtures/ux";

/**
 * PERSONA-COMPLIANCE-AUDIT — 컴플라이언스/감사 (ROADMAP §8 persona workflow
 * matrix, docs/design/oyatie-console/ROADMAP.md; no "✓ audit" tag — not yet
 * validated even against the design mock).
 *
 * SUPER_ADMIN is the real backend/nav match: `audit` (raw log) is
 * ADMIN_ROLES-gated, `compliance` (findings/anomaly review) is
 * INTEGRITY_ROLES-gated, and `policy` (권한·정책 — the persona's "정책 시뮬·
 * override 게이트") is ROLE_MANAGE_ROLES-gated (SUPER_ADMIN only) — SUPER_ADMIN
 * is the only role in all three sets simultaneously.
 *
 * The second test proves the specific boundary the persona exists to enforce:
 * ADMIN is deliberately excluded from `compliance` (nav.ts's own comment: "ADMIN
 * excluded by design") even though ADMIN holds every other management surface —
 * i.e. compliance review is a distinct governance tier, not just "ADMIN plus
 * more". That is the persona's actual reason to exist as a matrix row.
 */

const T = {
  nav: "주 메뉴",
  overview: "통합 개요",
  audit: "감사 로그",
  compliance: "컴플라이언스",
  policy: "권한·정책",
  finance: "재무",
} as const;

test("PERSONA-COMPLIANCE-AUDIT super_admin reaches audit feed + compliance findings + policy nav", async ({
  page,
  loginAs,
}) => {
  const consoleGuard = attachConsoleGuard(page);

  await loginAs("SUPER_ADMIN");
  await page.goto("/console");
  await page.waitForSelector("[data-console-root]", { timeout: 15_000 });

  const nav = page.getByRole("navigation", { name: T.nav });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole("button", { name: T.audit })).toBeVisible();
  await expect(nav.getByRole("button", { name: T.compliance })).toBeVisible();
  await expect(nav.getByRole("button", { name: T.policy })).toBeVisible();

  await nav.getByRole("button", { name: T.audit }).click();
  await expect(page.locator("[data-cshell-screen='audit']")).toBeVisible();
  await nav.getByRole("button", { name: T.compliance }).click();
  await expect(page.locator("[data-cshell-screen='compliance']")).toBeVisible();
  await nav.getByRole("button", { name: T.policy }).click();
  await expect(page.locator("[data-cshell-screen='policy']")).toBeVisible();

  await auditPage(page, { context: "/console (compliance/super_admin)", consoleGuard });
});

test("PERSONA-COMPLIANCE-AUDIT compliance findings stay hidden from ADMIN — a distinct governance tier, not ADMIN-plus", async ({
  page,
  loginAs,
}) => {
  await loginAs("ADMIN");
  await page.goto("/console");
  await page.waitForSelector("[data-console-root]", { timeout: 15_000 });

  const nav = page.getByRole("navigation", { name: T.nav });
  // ADMIN keeps every other management surface (proves this is a deliberate
  // compliance-specific exclusion, not a general privilege gap).
  await expect(nav.getByRole("button", { name: T.finance })).toBeVisible();
  await expect(nav.getByRole("button", { name: T.audit })).toBeVisible();
  // ...but not the curated compliance findings/anomaly review tier.
  await expect(nav.getByRole("button", { name: T.compliance })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: T.policy })).toHaveCount(0);
});
