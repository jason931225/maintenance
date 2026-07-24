import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

import {
  assertNoAxeViolations,
  assertNoRawI18nKeys,
  attachConsoleGuard,
} from "../fixtures/ux";

/**
 * ATTENDANCE-31 — persisted Attendance-console operator story.
 *
 * This runs exclusively in the explicit dev-auth Playwright project. It neither
 * mounts a fixture transport nor substitutes API responses: the browser uses
 * `/console/attendance`, a real dev-auth session, the generated-client-backed
 * HTTP surface, and PostgreSQL. The narrowly scoped SQL below creates only the
 * prerequisite business facts that a fresh local dev database cannot obtain by
 * clicking the console (an OPEN exception and a 52-hour weekly history). Every
 * user-visible transition is performed through the product UI; the two REST
 * operations not yet exposed in the reviewed screen (substitution cancellation
 * and close amendment) are exercised against the same authenticated HTTP
 * boundary and asserted in PostgreSQL.
 *
 * Production exclusion is defense in depth:
 * - Playwright only creates this project when MNT_DEV_AUTH_E2E=1.
 * - This module refuses to seed unless both local-dev feature flags are exact.
 * - The app's default/release graph compiles dev-auth out entirely.
 */

const ORG_ID = "00000000-0000-0000-0000-0000000000a1";
const REGION_ID = "00000000-0000-0000-0000-0000000000b1";
const BRANCH_ID = randomUUID();
const branchName = `E2E 근태 지점 ${BRANCH_ID.slice(0, 8)}`;
const SEED_ACTOR_ID = "00000000-0000-0000-0000-00000000d001";
const DATABASE_URL =
  process.env.MNT_DEV_DATABASE_URL ??
  "postgres://mnt_rt:mnt-dev-runtime-change-me@127.0.0.1:55432/mnt_dev";

const runId = randomUUID();
const blockedEmployeeId = randomUUID();
const riskEmployeeId = randomUUID();
const blockedEmployeeName = `E2E 근태 결원 ${runId.slice(0, 8)}`;
const riskEmployeeName = `E2E 주52시간 ${runId.slice(0, 8)}`;
const coverExceptionCode = `AT-E2E-COVER-${runId.slice(0, 8).toUpperCase()}`;
const closeExceptionCode = `AT-E2E-CLOSE-${runId.slice(0, 8).toUpperCase()}`;
const reason = `e2e 근태 확인 ${runId}`;

const SEOUL_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
});

/** Korean operations use an Asia/Seoul business day, never the runner's UTC day. */
function seoulIsoDate(value: Date): string {
  return SEOUL_DATE.format(value);
}

function nextMonth(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new RangeError(`Invalid month: ${month}`);
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]), 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

function addDays(date: string, amount: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new RangeError(`Invalid date: ${date}`);
  const shifted = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + amount),
  );
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

function seoulWeekStart(value: Date): string {
  const date = seoulIsoDate(value);
  const noonUtc = new Date(`${date}T12:00:00Z`);
  return addDays(date, -((noonUtc.getUTCDay() + 6) % 7));
}

const now = new Date();
const todayValue = seoulIsoDate(now);
const closeMonthValue = nextMonth(todayValue.slice(0, 7));
const [closeYear, closeMonthNumber] = closeMonthValue.split("-").map(Number);
const coverDate = `${closeMonthValue}-15`;
const weekStartValue = seoulWeekStart(now);

type DevRole = "관리자" | "일반 멤버";

type DevAuthResponse = { access_token: string };

function assertDevOnlyEnvironment(): void {
  if (
    process.env.MNT_DEV_AUTH_E2E !== "1" ||
    process.env.VITE_CONSOLE_DEV_PREVIEW !== "1"
  ) {
    throw new Error(
      "ATTENDANCE-31 may run only with MNT_DEV_AUTH_E2E=1 and VITE_CONSOLE_DEV_PREVIEW=1.",
    );
  }
}

function execSql(sql: string): string {
  return execFileSync(
    "psql",
    [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-At", "-c", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Dev-auth/e2e-only DB prerequisites, all unique to this test run. */
function seedAttendanceStory(): void {
  assertDevOnlyEnvironment();
  const weekDays = Array.from({ length: 5 }, (_, day) =>
    addDays(weekStartValue, day),
  );
  const clockRows = weekDays
    .flatMap((workDate, day) => {
      const inId = randomUUID();
      const outId = randomUUID();
      const inKey = `attendance-live-e2e-in-${runId}-${day}`;
      const outKey = `attendance-live-e2e-out-${runId}-${day}`;
      return [
        `(${sqlLiteral(inId)}, ${sqlLiteral(ORG_ID)}, ${sqlLiteral(riskEmployeeId)}, ${sqlLiteral(SEED_ACTOR_ID)}::uuid, 'CLOCK_IN', ${sqlLiteral(`${workDate}T00:00:00+09:00`)}::timestamptz, ${sqlLiteral(workDate)}::date, 'CLOCKED_IN', ${sqlLiteral(inKey)})`,
        `(${sqlLiteral(outId)}, ${sqlLiteral(ORG_ID)}, ${sqlLiteral(riskEmployeeId)}, ${sqlLiteral(SEED_ACTOR_ID)}::uuid, 'CLOCK_OUT', ${sqlLiteral(`${workDate}T11:00:00+09:00`)}::timestamptz, ${sqlLiteral(workDate)}::date, 'OFF_DUTY', ${sqlLiteral(outKey)})`,
      ];
    })
    .join(",\n");

  const sql = `
    BEGIN;
    SET LOCAL app.current_org = ${sqlLiteral(ORG_ID)};
    INSERT INTO branches (id, region_id, name, org_id) VALUES (
      ${sqlLiteral(BRANCH_ID)}, ${sqlLiteral(REGION_ID)}, ${sqlLiteral(branchName)}, ${sqlLiteral(ORG_ID)}
    );

    INSERT INTO employees (
      id, org_id, company, name, source_filename, source_sheet, source_row,
      source_key, employment_status, org_unit
    ) VALUES
      (${sqlLiteral(blockedEmployeeId)}, ${sqlLiteral(ORG_ID)}, 'E2E', ${sqlLiteral(blockedEmployeeName)}, 'attendance-live-e2e', 'attendance', 1, ${sqlLiteral(`attendance-live-e2e-blocked-${runId}`)}, 'ACTIVE', 'E2E 근태'),
      (${sqlLiteral(riskEmployeeId)}, ${sqlLiteral(ORG_ID)}, 'E2E', ${sqlLiteral(riskEmployeeName)}, 'attendance-live-e2e', 'attendance', 2, ${sqlLiteral(`attendance-live-e2e-risk-${runId}`)}, 'ACTIVE', 'E2E 근태');

    INSERT INTO attendance_exceptions (
      id, org_id, code, kind, status, employee_id, branch_id, work_date,
      detail, evidence, links, idempotency_key, request_fingerprint, created_by
    ) VALUES
      (
        ${sqlLiteral(randomUUID())}, ${sqlLiteral(ORG_ID)}, ${sqlLiteral(coverExceptionCode)}, 'NO_SHOW', 'OPEN',
        ${sqlLiteral(blockedEmployeeId)}, ${sqlLiteral(BRANCH_ID)}, ${sqlLiteral(todayValue)}::date,
        ${sqlLiteral(`e2e today cover gap ${runId}`)}, '[]'::jsonb, '[]'::jsonb,
        ${sqlLiteral(`attendance-live-e2e-cover-${runId}`)}, repeat('a', 64), ${sqlLiteral(SEED_ACTOR_ID)}::uuid
      ),
      (
        ${sqlLiteral(randomUUID())}, ${sqlLiteral(ORG_ID)}, ${sqlLiteral(closeExceptionCode)}, 'NO_SHOW', 'OPEN',
        ${sqlLiteral(blockedEmployeeId)}, ${sqlLiteral(BRANCH_ID)}, ${sqlLiteral(coverDate)}::date,
        ${sqlLiteral(`e2e future close blocker ${runId}`)}, '[]'::jsonb, '[]'::jsonb,
        ${sqlLiteral(`attendance-live-e2e-close-${runId}`)}, repeat('b', 64), ${sqlLiteral(SEED_ACTOR_ID)}::uuid
      );

    INSERT INTO employee_attendance_records (
      id, org_id, employee_id, actor_user_id, kind, occurred_at, work_date,
      state_after, idempotency_key
    ) VALUES
      ${clockRows};
    COMMIT;
  `;
  execSql(sql);
}

function scalar(sql: string): string {
  return execSql(`BEGIN; SET LOCAL app.current_org = ${sqlLiteral(ORG_ID)}; ${sql}; COMMIT;`);
}

async function loginAs(page: Page, role: DevRole): Promise<void> {
  await page.goto("/login");
  await page.getByRole("button", { name: /역할 전환 로그인/ }).click();
  await page.getByRole("combobox").selectOption({ label: role });
  await page.getByLabel(/지점 ID/).fill(BRANCH_ID);
  await page.getByRole("button", { name: "역할로 로그인" }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

async function mintAdminToken(request: APIRequestContext): Promise<string> {
  const response = await request.post("/api/v1/dev-auth/session", {
    data: { org_id: ORG_ID, role: "ADMIN", branch_ids: [BRANCH_ID] },
  });
  expect(
    response.status(),
    "dev-auth must mint the same real ADMIN session used by the UI",
  ).toBe(200);
  const body = (await response.json()) as DevAuthResponse;
  expect(body.access_token).toEqual(expect.any(String));
  return body.access_token;
}

test("ATTENDANCE-31 derives the Korean business calendar across a UTC boundary", () => {
  const utcBoundary = new Date("2026-07-31T15:30:00.000Z");
  expect(seoulIsoDate(utcBoundary)).toBe("2026-08-01");
  expect(nextMonth(seoulIsoDate(utcBoundary).slice(0, 7))).toBe("2026-09");
  expect(seoulWeekStart(utcBoundary)).toBe("2026-07-27");
});

test.describe("ATTENDANCE-31 live operator story", () => {
  test.beforeAll(() => {
    seedAttendanceStory();
  });

test("ATTENDANCE-31 admin resolves a persisted exception, assigns and cancels cover, acknowledges Week-52, closes, and amends", async ({
  page,
  request,
}) => {
  const consoleGuard = attachConsoleGuard(page);
  await loginAs(page, "관리자");
  await page.goto("/console/attendance");
  await expect(page).toHaveURL(/\/console\/attendance(?:$|[?#])/, {
    timeout: 15_000,
  });
  await expect(
    page.getByRole("heading", { name: "근태", level: 1 }),
  ).toBeVisible({ timeout: 15_000 });

  // Assignment is driven through the current-day product UI and its real
  // attendance pool. The current-day exception is distinct from the later
  // future-month close blocker so each assertion has exactly one cause.
  const dayGap = page
    .locator(".attendance__dayrow")
    .filter({ hasText: blockedEmployeeName });
  await expect(dayGap).toBeVisible({ timeout: 15_000 });
  await dayGap.getByRole("button", { name: "대근 편성" }).click();
  const substitutionDialog = page.getByRole("dialog", { name: "대근 편성" });
  await expect(substitutionDialog).toBeVisible();
  await substitutionDialog.getByLabel("현장").fill("E2E 현장");
  await substitutionDialog.getByLabel("역할").fill("현장 지원");
  await substitutionDialog.getByLabel("시작").fill("09:00");
  await substitutionDialog.getByLabel("종료").fill("18:00");
  await substitutionDialog.getByLabel("이름 검색").fill("김정비");
  await expect(
    substitutionDialog.getByText("김정비", { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await substitutionDialog.getByRole("button", { name: "배정" }).click();
  await expect(substitutionDialog).toHaveCount(0, { timeout: 15_000 });

  const substitutionId = scalar(
    `SELECT id FROM attendance_substitutions WHERE org_id = ${sqlLiteral(ORG_ID)} AND exception_id = (SELECT id FROM attendance_exceptions WHERE org_id = ${sqlLiteral(ORG_ID)} AND code = ${sqlLiteral(coverExceptionCode)})`,
  );
  expect(substitutionId).toMatch(/^[0-9a-f-]{36}$/i);

  // Cancellation is a complete, authenticated REST capability; the current UI
  // deliberately has no cancellation control, so exercise the production route
  // rather than pretending a UI control exists.
  const token = await mintAdminToken(request);
  const cancellation = await request.post(
    `/api/v1/attendance/substitutions/${substitutionId}/cancel`,
    {
      headers: { Authorization: `Bearer ${token}` },
      data: { reason: `e2e coverage no longer required ${runId}` },
    },
  );
  expect(cancellation.status()).toBe(200);
  expect(
    scalar(
      `SELECT status FROM attendance_substitutions WHERE id = ${sqlLiteral(substitutionId)}`,
    ),
  ).toBe("CANCELLED");

  // Move to the isolated future month. This avoids unrelated current-month
  // leave data while exercising the same server-derived close preflight.
  await page.getByRole("button", { name: "월간" }).click();
  await page.getByRole("button", { name: "다음 달" }).click();
  await expect(
    page.getByText(
      `${closeYear}년 ${closeMonthNumber}월`,
    ),
  ).toBeVisible();
  const exceptionRow = page
    .getByRole("button")
    .filter({ hasText: blockedEmployeeName });
  await expect(exceptionRow).toBeVisible({ timeout: 15_000 });

  // An open exception must block close before an operator can attest it.
  await expect(
    page.getByRole("button", {
      name: /근태 예외 .* 처리 후 마감할 수 있습니다/,
    }),
  ).toBeVisible();

  // Resolve the future-month close blocker through the visible UI, preserving
  // the close gate's causal sequence instead of mutating its DB state in test.
  await exceptionRow.click();
  const exceptionDialog = page.getByRole("dialog", { name: "근태 예외 상세" });
  await expect(exceptionDialog).toBeVisible();
  await exceptionDialog.getByLabel("처리 사유").fill(reason);
  await exceptionDialog.getByRole("button", { name: "확인 처리" }).click();
  await expect(exceptionDialog).toHaveCount(0, { timeout: 15_000 });
  await expect(exceptionRow.getByText("처리됨")).toBeVisible();
  expect(
    scalar(
      `SELECT status FROM attendance_exceptions WHERE org_id = ${sqlLiteral(ORG_ID)} AND code = ${sqlLiteral(closeExceptionCode)}`,
    ),
  ).toBe("RESOLVED");

  // Week-52 acknowledgement is likewise a real UI mutation backed by the
  // seeded five-day 55h history.
  const week52Panel = page.getByLabel("주 52시간 모니터");
  await expect(
    week52Panel.getByText(riskEmployeeName, { exact: true }),
  ).toBeVisible();
  await week52Panel.getByRole("button", { name: "근무 조정" }).click();
  await expect(week52Panel.getByText("요청됨")).toBeVisible({
    timeout: 15_000,
  });
  expect(
    scalar(
      `SELECT count(*) FROM attendance_week52_acknowledgements WHERE org_id = ${sqlLiteral(ORG_ID)} AND employee_id = ${sqlLiteral(riskEmployeeId)} AND week_start = ${sqlLiteral(weekStartValue)}::date`,
    ),
  ).toBe("1");

  // With the sole future-month exception resolved, server-derived preflight
  // admits close. The operator explicitly attests before committing it.
  await page
    .getByRole("button", { name: new RegExp(`${BRANCH_ID} 마감 확정`) })
    .click();
  const closeDialog = page.getByRole("dialog", {
    name: "마감 확정 — 사전 점검",
  });
  await expect(closeDialog).toBeVisible();
  await expect(
    closeDialog.getByText("미처리 예외가 남아 마감할 수 없습니다."),
  ).toHaveCount(0);
  await closeDialog
    .getByLabel("점검 결과를 확인했으며 마감을 확정합니다")
    .check();
  await closeDialog
    .getByRole("button", { name: new RegExp(`${BRANCH_ID} 마감 확정`) })
    .click();
  await expect(closeDialog).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText("마감 완료 — 급여 계산 가능")).toBeVisible({
    timeout: 15_000,
  });

  const closeId = scalar(
    `SELECT id FROM attendance_month_closes WHERE org_id = ${sqlLiteral(ORG_ID)} AND branch_id = ${sqlLiteral(BRANCH_ID)} AND month = ${sqlLiteral(`${closeMonthValue}-01`)}::date`,
  );
  expect(closeId).toMatch(/^[0-9a-f-]{36}$/i);

  // Amendment follows the exact authenticated REST boundary (the transport
  // supports it, but this screen has not yet added an amendment control).
  const amendment = await request.post(
    `/api/v1/attendance/closes/${closeId}/amend`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": randomUUID(),
      },
      data: {
        reason: "e2e verified late evidence",
        detail: `post-close evidence receipt ${runId}`,
        ref: `E2E-${runId}`,
      },
    },
  );
  expect(amendment.status()).toBe(200);
  expect(
    scalar(
      `SELECT count(*) FROM attendance_close_amendments WHERE org_id = ${sqlLiteral(ORG_ID)} AND close_id = ${sqlLiteral(closeId)}`,
    ),
  ).toBe("1");

  await assertNoRawI18nKeys(page);
  await assertNoAxeViolations(page, {
    context: "attendance console completed operator story",
  });
  consoleGuard.assertClean();
});

test("ATTENDANCE-31 reader persona is denied by omission before attendance data loads", async ({
  page,
}) => {
  await loginAs(page, "일반 멤버");
  await page.goto("/console/attendance");
  await expect(
    page.getByRole("heading", { name: "근태", level: 1 }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("status")).toHaveText(
    "근태 현황을 볼 권한이 없습니다.",
  );
  await expect(page.getByLabel("근태 예외")).toHaveCount(0);
  await assertNoRawI18nKeys(page);
  await assertNoAxeViolations(page, {
    context: "attendance reader denied-by-omission",
  });
});
});
