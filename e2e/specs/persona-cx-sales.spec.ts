import { test, expect } from "../fixtures/roles";
import { attachConsoleGuard, auditPage } from "../fixtures/ux";

/**
 * PERSONA-CX-SALES — CX/영업 (ROADMAP §8 persona workflow matrix,
 * docs/design/oyatie-console/ROADMAP.md; the entry with no "✓ audit" tag —
 * i.e. not yet validated even against the design mock).
 *
 * No distinct CX/Sales backend role or nav item exists (`backend/crates/
 * platform/authz::Role` has 6 variants; console nav.ts gates on those same 6).
 * ADMIN is the closest real proxy: it is the only role with simultaneous
 * access to mail (external correspondence), finance (quote/voucher
 * reconciliation), and appr (contract-draft approval guardrail) — the three
 * real, wired surfaces the persona's described flow touches.
 *
 * Honesty note: the persona's literal flow ("외부 메일(견적 CS-)→계약 기안
 * (가드레일)→공고/편성 체인") names a dedicated CS- quote-ticket module that is
 * NOT wired into this console (`web/src/console/modules/moduleScreens.ts`
 * MOD_SCREENS only hand-authors finance/asset/compliance; the sales_listings/
 * customer_inquiries context from the separate storefront project is not
 * console-integrated). This spec locks the real subset — mail + finance +
 * appr + recruit(공고) reachability and the real deny-by-omission boundary —
 * rather than asserting a CS- ticket flow that does not exist yet.
 */

const T = {
  nav: "주 메뉴",
  overview: "통합 개요",
  mail: "메일",
  finance: "재무",
  appr: "전자결재",
  recruit: "채용",
  compliance: "컴플라이언스",
  policy: "권한·정책",
  workflow: "워크플로 스튜디오",
} as const;

test("PERSONA-CX-SALES admin (nearest proxy) reaches mail/finance/appr/recruit nav, denied compliance/policy/automation", async ({
  page,
  loginAs,
}) => {
  const consoleGuard = attachConsoleGuard(page);

  await loginAs("ADMIN");
  await page.goto("/console");
  await page.waitForSelector("[data-console-root]", { timeout: 15_000 });

  const nav = page.getByRole("navigation", { name: T.nav });
  await expect(nav).toBeVisible();

  // Allowed: mail (external correspondence) + finance (quote/voucher) + appr
  // (contract approval guardrail) + recruit (공고/편성 chain) — the real subset
  // of the described CX/Sales flow.
  await expect(nav.getByRole("button", { name: T.overview })).toBeVisible();
  await expect(nav.getByRole("button", { name: T.mail })).toBeVisible();
  await expect(nav.getByRole("button", { name: T.finance })).toBeVisible();
  await expect(nav.getByRole("button", { name: T.appr })).toBeVisible();
  await expect(nav.getByRole("button", { name: T.recruit })).toBeVisible();

  // Denied by design: compliance findings (EXECUTIVE/SUPER_ADMIN-only) and
  // role-manage automation (SUPER_ADMIN-only) stay hidden from ADMIN.
  await expect(nav.getByRole("button", { name: T.compliance })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: T.policy })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: T.workflow })).toHaveCount(0);

  await nav.getByRole("button", { name: T.mail }).click();
  await expect(page.locator("[data-cshell-screen='mail']")).toBeVisible();

  await auditPage(page, { context: "/console (cx-sales/admin proxy)", consoleGuard });
});
