import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import {
  assertNoAxeViolations,
  assertNoRawI18nKeys,
  navigateByHref,
} from "../fixtures/ux";

/**
 * HR-30 — absence → exit → settlement, the full G009 user story end to end.
 *
 * This is the browser proof for US-008/US-011: an attendance gap surfaces an
 * absence alert; a manager reports the exit; HR confirms; a DIFFERENT actor
 * (HQ) makes the second-tier confirmation the backend's separation-of-duties
 * rule requires; then the settlement wage source is entered and the package is
 * submitted for approval — all driven from the insurance-assist exit-workflow
 * surface (/hr/insurance), since check:payroll-release-gate forbids mutation
 * API calls on the payroll readiness page. The severance figure and its
 * "산정 초안 — 노무사 검증 전" uncertified-draft label are then verified as a
 * READ-ONLY display on the payroll page.
 *
 * Auth model: the local dev-auth role switcher (same stack as
 * auth-09-dev-role-switcher.spec.ts). It mints REAL signed sessions per role
 * against a backend built `--features dev-auth`; distinct roles map to distinct
 * backing users, which is exactly what the HR-vs-HQ distinct-actor rule needs:
 *   - 최고 관리자 (SUPER_ADMIN)  → reports the exit, HR-confirms, and settles
 *     (holds ExitCaseReport + ExitCaseHrConfirm + ExitSettlementManage);
 *   - 임원 (EXECUTIVE)          → HQ-confirms as a SEPARATE user
 *     (holds ExitCaseHqConfirm; user id differs from the HR confirmer).
 *
 * Runs ONLY under the dev-auth Playwright project (MNT_DEV_AUTH_E2E=1). Bring up
 * the real stack first — `MNT_DEV_AUTH_E2E=1 node scripts/dev-up.mjs bootstrap`
 * (backend `--features dev-auth` + Vite dev server) — then run this config; see
 * playwright.config.ts.
 */

/** KNL Logistics — tenant #1, seeded by every migration/cold-start. */
const KNL_ORG_ID = "00000000-0000-0000-0000-0000000000a1";

/**
 * Dev DB the dev-auth stack (`scripts/dev-up.mjs`) runs against. The absence
 * alert is materialized from imported attendance in production; here we seed one
 * OPEN alert (plus its employee) directly so the story can start from the
 * dashboard warning without driving a full xlsx import first. Seeding arms the
 * tenant GUC and runs as the runtime role, exactly like the app's own writes.
 */
const DATABASE_URL =
  process.env.MNT_DEV_DATABASE_URL ??
  "postgres://mnt_app:mnt-dev-local-change-me@127.0.0.1:55432/mnt_dev";

const employeeId = randomUUID();
const alertId = randomUUID();
const employeeName = `e2e 퇴사대상 ${employeeId.slice(0, 8)}`;
const workDate = "2026-07-01";

function seedAbsenceAlert(): void {
  // Fresh employee + alert per run (unique ids). We deliberately do NOT delete
  // prior runs' rows: a confirmed exit writes an append-only
  // employee_lifecycle_events row, so its employee can never be deleted. The
  // spec instead scopes every interaction to THIS run's employee, and the
  // dashboards order newest-first so the freshly seeded row is always on top.
  const sql = `
    SET ROLE mnt_rt;
    SET app.current_org = '${KNL_ORG_ID}';
    INSERT INTO employees (
      id, org_id, company, name,
      source_filename, source_sheet, source_row, source_key,
      hire_date, employment_status, identity_review_required
    ) VALUES (
      '${employeeId}', '${KNL_ORG_ID}', 'KNL', '${employeeName}',
      'e2e-seed.xlsx', 'e2e', 1, 'e2e-exit-${employeeId}',
      '2020-01-02', 'ACTIVE', false
    );
    INSERT INTO employee_absence_alerts (
      id, org_id, employee_id, work_date, status, source, severity
    ) VALUES (
      '${alertId}', '${KNL_ORG_ID}', '${employeeId}', '${workDate}',
      'OPEN', 'manual', 'WARNING'
    );
  `;
  execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], {
    stdio: "pipe",
  });
}

/**
 * Mint a fresh dev-auth session for `roleLabel`. Logs out any current session
 * first (so a second actor really is a second backing user, not the same token),
 * then drives the /login role switcher.
 */
async function loginAs(page: Page, roleLabel: string): Promise<void> {
  await page.goto("/login");
  await page.evaluate(async () => {
    await fetch("/api/v1/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Transport": "cookie" },
      credentials: "include",
      body: "{}",
    });
  });
  await page.goto("/login");

  await page.getByRole("button", { name: /역할 전환 로그인/ }).click();
  // The role picker is the only <select> (combobox) in the switcher; the org and
  // branch fields are text inputs. getByLabel("역할") is ambiguous — the wrapping
  // label's accessible name folds in the option text, and the branch label also
  // contains "역할".
  await page.getByRole("combobox").selectOption({ label: roleLabel });
  await page.getByRole("button", { name: "역할로 로그인" }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

test.beforeAll(() => {
  seedAbsenceAlert();
});

test("G009 absence gap → exit report → HR confirm → HQ confirm (distinct actor) → wage source → severance draft → approval submission", async ({
  page,
}) => {
  // No whole-flow console-clean gate here: this story deliberately switches
  // between roles (SUPER_ADMIN ↔ EXECUTIVE), and role-scoped background fetches
  // (shell badges/polling a given role cannot read) return expected 403s the app
  // handles gracefully. The UX bar is enforced per surface below via axe + i18n
  // audits, matching the sibling dev-auth spec (auth-09) which likewise does not
  // assert a globally clean console across role switches.

  // --- Actor A (최고 관리자): sees the absence alert and reports the exit. ---
  await loginAs(page, "최고 관리자");
  // SPA navigation (not page.goto): a hard reload of a dev-auth session re-runs
  // boot silent-refresh, which recomputes requires_passkey_setup from the DB and
  // forces the onboarding screen (the persona has no real passkey) — see
  // auth-09-dev-role-switcher.spec.ts.
  await navigateByHref(page, "/hr/insurance");
  await expect(
    page.getByRole("heading", { name: "보험신고 지원", level: 1 }),
  ).toBeVisible({ timeout: 15_000 });

  const workflowPanel = page.getByText("결근·퇴사·상실신고 경고");
  await expect(workflowPanel).toBeVisible();
  const alertItem = page
    .getByRole("listitem")
    .filter({ hasText: employeeName });
  await expect(alertItem).toBeVisible();
  await assertNoRawI18nKeys(page);
  await assertNoAxeViolations(page, { context: "insurance-assist (absence alert)" });

  await alertItem.getByRole("button", { name: "퇴사 확인 케이스 생성" }).click();
  await expect(page.getByText("퇴사 확인 케이스를 생성했습니다.")).toBeVisible({
    timeout: 15_000,
  });

  // --- Actor A: HR confirmation of the reported case. ---
  await page.getByRole("button", { name: "사업장 HR 확인" }).click();
  await expect(page.getByText("퇴사 확인과 정산 패키지 생성을 반영했습니다.")).toBeVisible({
    timeout: 15_000,
  });

  // --- Actor B (임원): the distinct HQ confirmer the backend requires. ---
  await loginAs(page, "임원");
  await navigateByHref(page, "/hr/insurance");
  await expect(
    page.getByRole("heading", { name: "보험신고 지원", level: 1 }),
  ).toBeVisible({ timeout: 15_000 });
  const hqConfirm = page.getByRole("button", { name: "HQ HR 확인" });
  await expect(hqConfirm).toBeVisible({ timeout: 15_000 });
  await hqConfirm.click();
  await expect(page.getByText("퇴사 확인과 정산 패키지 생성을 반영했습니다.")).toBeVisible({
    timeout: 15_000,
  });

  // --- Actor A: settle via the insurance-assist mutation surface — wage
  // source entry and draft generation. PayrollPage is READ-ONLY (see
  // check:payroll-release-gate), so these mutations live here instead. ---
  await loginAs(page, "최고 관리자");
  await navigateByHref(page, "/hr/insurance");
  await expect(
    page.getByRole("heading", { name: "보험신고 지원", level: 1 }),
  ).toBeVisible({ timeout: 15_000 });

  // Scope to THIS run's case within the confirmation/settlement list — prior
  // runs may leave other exit cases in workable states in the same top-N slice.
  // The shared Card component also renders a <section>, so the panel-level
  // <section> wrapping BOTH sub-lists also matches by text; .last() picks the
  // innermost (confirmation-list-only) section.
  const confirmationSection = page
    .locator("section")
    .filter({ hasText: "퇴사 확인 및 상실신고 준비" })
    .last();
  const settlementItem = confirmationSection
    .getByRole("listitem")
    .filter({ hasText: employeeName });
  await expect(settlementItem).toBeVisible();

  // Wage-source entry drives the statutory severance calculation.
  await expect(settlementItem.getByText("평균임금 원천 입력")).toBeVisible();
  await settlementItem.getByLabel("산정 시작일").fill("2026-04-01");
  await settlementItem.getByLabel("산정 종료일").fill("2026-06-30");
  await settlementItem.getByLabel("산정 역일수").fill("91");
  await settlementItem.getByLabel("산정 기간 임금총액(원)").fill("9000000");
  await settlementItem.getByLabel("월 통상임금(원)").fill("3000000");
  await settlementItem.getByRole("button", { name: "정산 초안 산출" }).click();

  await expect(page.getByText("퇴직금 정산 초안을 산출했습니다.")).toBeVisible({
    timeout: 15_000,
  });
  await assertNoRawI18nKeys(page);
  await assertNoAxeViolations(page, { context: "insurance-assist (settlement draft)" });

  // --- The severance figure + uncertified-draft label render READ-ONLY on
  // the payroll surface — a labor attorney has not yet certified the draft. ---
  await navigateByHref(page, "/payroll");
  await expect(
    page.getByRole("heading", { name: "급여 준비", level: 1 }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("퇴직금·상실신고 정산")).toBeVisible();

  // Scope to THIS run's case card — prior runs may leave other settlement cards.
  // Card renders a <section>, so the panel <section> also matches by text; .last()
  // picks the innermost (this case's) card.
  const settlementCard = page
    .locator("section")
    .filter({ hasText: employeeName })
    .last();
  await expect(settlementCard).toBeVisible();
  await expect(settlementCard.getByText("퇴직금 산출액", { exact: true })).toBeVisible();
  await expect(settlementCard.getByText("산정 초안 — 노무사 검증 전")).toBeVisible();
  await assertNoRawI18nKeys(page);
  await assertNoAxeViolations(page, { context: "payroll (settlement draft, read-only)" });

  // --- Approval submission closes the story, driven from the
  // insurance-assist mutation surface. ---
  await navigateByHref(page, "/hr/insurance");
  const submitItem = confirmationSection
    .getByRole("listitem")
    .filter({ hasText: employeeName });
  await submitItem.getByRole("button", { name: "승인 상신" }).click();
  await expect(page.getByText("퇴직금 정산을 승인 상신했습니다.")).toBeVisible({
    timeout: 15_000,
  });
});
