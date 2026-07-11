import { test, expect } from "../fixtures/roles";
import { attachConsoleGuard, auditPage } from "../fixtures/ux";

/**
 * PERSONA-EXECUTIVE — 임원/경영진 (ROADMAP §8 persona workflow matrix,
 * docs/design/oyatie-console/ROADMAP.md).
 *
 * Locks the EXECUTIVE nav boundary on the REAL `/console` shell
 * (web/src/console/shell/nav.ts, deny-by-omission) into automated E2E, using
 * the seeded WebAuthn EXECUTIVE role (e2e/fixtures/roles.ts) rather than the
 * dev-auth role switcher — this stays inside the standard e2e harness so the
 * spec runs in the default `chromium` project alongside every other
 * WebAuthn-authenticated spec, no dev-auth stack required.
 *
 * Scope note: `ConsoleShell`'s screen body is still the P0.1 empty canvas
 * (`data-cshell-screen` flips, but no module renders inside it yet — see
 * ConsoleShell.tsx's own "Screens compose here in later slices" comment). So
 * this spec proves what is real today: nav visibility (the persona's actual
 * "dashboard→labor cost→final approval→audit stream" surface reachability)
 * and screen-switch chrome. It deliberately does not assert module CONTENT
 * (KPI numbers, drill targets) — that's exec-01-kpi.spec.ts's job on the
 * legacy /kpi route, which already proves the report/data layer for this
 * role; this spec is the console-nav-layer complement.
 *
 * Design-vs-code note: the design log claims the executive persona reaches a
 * "감사 스트림" (audit stream); the real nav gate excludes EXECUTIVE from the
 * raw "audit" (ADMIN_ROLES-only) item but grants "compliance" (curated
 * findings/anomaly review, INTEGRITY_ROLES) — asserted below as the accurate
 * real boundary, not the design copy.
 */

const T = {
  nav: "주 메뉴",
  body: "화면 본문",
  overview: "통합 개요",
  dashboard: "대시보드",
  laborcost: "인건비 분석",
  forecast: "예측",
  objectExplorer: "객체 탐색",
  finance: "재무",
  appr: "전자결재",
  compliance: "컴플라이언스",
  audit: "감사 로그",
  policy: "권한·정책",
  workflow: "워크플로 스튜디오",
  scheduled: "예약 작업",
} as const;

test("PERSONA-EXEC executive reaches dashboard/labor-cost/compliance nav, denied audit/policy/automation", async ({
  page,
  loginAs,
}) => {
  const consoleGuard = attachConsoleGuard(page);

  await loginAs("EXECUTIVE");
  await page.goto("/console");
  await page.waitForSelector("[data-console-root]", { timeout: 15_000 });

  const nav = page.getByRole("navigation", { name: T.nav });
  await expect(nav).toBeVisible();

  // Allowed: the executive's real workflow surface (management + integrity tier).
  await expect(nav.getByRole("button", { name: T.overview })).toBeVisible();
  await expect(nav.getByRole("button", { name: T.dashboard })).toBeVisible();
  await expect(nav.getByRole("button", { name: T.laborcost })).toBeVisible();
  await expect(nav.getByRole("button", { name: T.forecast })).toBeVisible();
  await expect(nav.getByRole("button", { name: T.objectExplorer })).toBeVisible();
  await expect(nav.getByRole("button", { name: T.finance })).toBeVisible();
  await expect(nav.getByRole("button", { name: T.appr })).toBeVisible();
  await expect(nav.getByRole("button", { name: T.compliance })).toBeVisible();

  // Denied by design: raw audit log (ADMIN-tier) and role-manage automation
  // (SUPER_ADMIN-only) stay hidden from an executive session.
  await expect(nav.getByRole("button", { name: T.audit })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: T.policy })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: T.workflow })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: T.scheduled })).toHaveCount(0);

  // Screen-switch chrome: state.screen navigation actually moves.
  await nav.getByRole("button", { name: T.dashboard }).click();
  await expect(nav.getByRole("button", { name: T.dashboard })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.getByLabel(T.body)).toHaveAttribute(
    "data-cshell-screen",
    "dashboard",
  );

  await auditPage(page, { context: "/console (executive)", consoleGuard });
});
