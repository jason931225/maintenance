import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  expect,
  test,
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
 * `/attendance`, a real dev-auth session, the generated-client-backed
 * HTTP surface, and PostgreSQL. The narrowly scoped SQL below creates only the
 * prerequisite business facts that a fresh local dev database cannot obtain by
 * clicking the console (an OPEN exception and a 52-hour weekly history), never
 * a fabricated substitution candidate. Every user-visible transition is
 * performed through the product UI and its persisted outcome is asserted in
 * PostgreSQL.
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
const OWNER_DATABASE_URL =
  process.env.MNT_DEV_DATABASE_OWNER_URL ??
  "postgres://mnt_app:mnt-dev-owner-change-me@127.0.0.1:55432/mnt_dev";

const runId = randomUUID();
const blockedEmployeeId = randomUUID();
const riskEmployeeId = randomUUID();
const eligibleCandidateId = randomUUID();
const wrongBranchCandidateId = randomUUID();
const inactiveCandidateId = randomUUID();
const approvedLeaveCandidateId = randomUUID();
const openNoShowCandidateId = randomUUID();
const overlapCandidateId = randomUUID();
const otherBranchId = randomUUID();
const leaveDeciderId = randomUUID();
const memberUserId = randomUUID();
const memberEmployeeId = randomUUID();
const memberExceptionId = randomUUID();
const memberOrgId = randomUUID();
const blockedEmployeeName = `E2E 근태 결원 ${runId.slice(0, 8)}`;
const riskEmployeeName = `E2E 주52시간 ${runId.slice(0, 8)}`;
const eligibleCandidateName = `E2E 후보 가능 ${runId.slice(0, 8)}`;
const wrongBranchCandidateName = `E2E 후보 타지점 ${runId.slice(0, 8)}`;
const inactiveCandidateName = `E2E 후보 비활성 ${runId.slice(0, 8)}`;
const approvedLeaveCandidateName = `E2E 후보 휴가 ${runId.slice(0, 8)}`;
const openNoShowCandidateName = `E2E 후보 결원 ${runId.slice(0, 8)}`;
const overlapCandidateName = `E2E 후보 중복 ${runId.slice(0, 8)}`;
const coverExceptionCode = `AT-E2E-COVER-${runId.slice(0, 8).toUpperCase()}`;
const closeExceptionCode = `AT-E2E-CLOSE-${runId.slice(0, 8).toUpperCase()}`;
const reason = `e2e 근태 확인 ${runId}`;
const memberEmployeeName = `E2E 본인 근태 ${runId.slice(0, 8)}`;
const memberExceptionCode = `AT-E2E-MEMBER-${runId.slice(0, 8).toUpperCase()}`;
const memberExceptionDetail = `e2e 본인 지각 확인 ${runId}`;
const memberEvidenceName = `e2e 출입기록 ${runId}.pdf`;
const memberOrgSlug = `e2e-member-${runId.replaceAll("-", "").slice(0, 16)}`;
const memberOrgName = `E2E 본인 근태 ${runId.slice(0, 8)}`;
const memberPhone = `dev-auth:${memberOrgId}:MEMBER`;

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

function execOwnerSql(sql: string): string {
  return execFileSync(
    "psql",
    [OWNER_DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-At", "-c", sql],
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
  const employeeRows = [
    [blockedEmployeeId, blockedEmployeeName, BRANCH_ID, "ACTIVE"],
    [riskEmployeeId, riskEmployeeName, BRANCH_ID, "ACTIVE"],
    [eligibleCandidateId, eligibleCandidateName, BRANCH_ID, "ACTIVE"],
    [wrongBranchCandidateId, wrongBranchCandidateName, otherBranchId, "ACTIVE"],
    [inactiveCandidateId, inactiveCandidateName, BRANCH_ID, "EXITED"],
    [approvedLeaveCandidateId, approvedLeaveCandidateName, BRANCH_ID, "ACTIVE"],
    [openNoShowCandidateId, openNoShowCandidateName, BRANCH_ID, "ACTIVE"],
    [overlapCandidateId, overlapCandidateName, BRANCH_ID, "ACTIVE"],
  ] as const;
  const employees = employeeRows
    .map(
      ([id, name, homeBranchId, employmentStatus], index) =>
        `(${sqlLiteral(id)}, ${sqlLiteral(ORG_ID)}, 'E2E', ${sqlLiteral(name)}, 'attendance-live-e2e', 'attendance', ${index + 1}, ${sqlLiteral(`attendance-live-e2e-${runId}-${index}`)}, ${sqlLiteral(employmentStatus)}, 'E2E 근태', ${sqlLiteral(homeBranchId)}::uuid)`,
    )
    .join(",\n");
  const profiles = employeeRows
    .map(
      ([id], index) =>
        `(${sqlLiteral(id)}::uuid, ${sqlLiteral(ORG_ID)}::uuid, 'REGULAR', ${sqlLiteral(`+821055${String(index).padStart(4, "0")}`)}, 1000000, 'KRW', ${sqlLiteral(`attendance-live-e2e-profile-${runId}-${index}`)}, repeat('c', 64), ${sqlLiteral(SEED_ACTOR_ID)}::uuid)`,
    )
    .join(",\n");

  const sql = `
    BEGIN;
    SET LOCAL app.current_org = ${sqlLiteral(ORG_ID)};
    INSERT INTO branches (id, region_id, name, org_id) VALUES
      (${sqlLiteral(BRANCH_ID)}, ${sqlLiteral(REGION_ID)}, ${sqlLiteral(branchName)}, ${sqlLiteral(ORG_ID)}),
      (${sqlLiteral(otherBranchId)}, ${sqlLiteral(REGION_ID)}, ${sqlLiteral(`E2E 타지점 ${runId.slice(0, 8)}`)}, ${sqlLiteral(ORG_ID)});

    INSERT INTO users (id, display_name, roles, org_id) VALUES
      (${sqlLiteral(leaveDeciderId)}, ${sqlLiteral(`E2E 휴가 결재자 ${runId.slice(0, 8)}`)}, ARRAY['ADMIN'], ${sqlLiteral(ORG_ID)});

    INSERT INTO employees (
      id, org_id, company, name, source_filename, source_sheet, source_row,
      source_key, employment_status, org_unit, home_branch_id
    ) VALUES ${employees};

    INSERT INTO employee_employment_profiles (
      employee_id, org_id, employment_type, phone_e164, base_pay, currency,
      idempotency_key, request_hash, created_by
    ) VALUES ${profiles};

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
      ),
      (
        ${sqlLiteral(randomUUID())}, ${sqlLiteral(ORG_ID)}, ${sqlLiteral(`AT-E2E-NOSHOW-${runId.slice(0, 8).toUpperCase()}`)}, 'NO_SHOW', 'OPEN',
        ${sqlLiteral(openNoShowCandidateId)}, ${sqlLiteral(BRANCH_ID)}, ${sqlLiteral(todayValue)}::date,
        ${sqlLiteral(`e2e candidate open no-show ${runId}`)}, '[]'::jsonb, '[]'::jsonb,
        ${sqlLiteral(`attendance-live-e2e-no-show-${runId}`)}, repeat('d', 64), ${sqlLiteral(SEED_ACTOR_ID)}::uuid
      );

    INSERT INTO leave_requests (
      id, org_id, branch_id, requester_user_id, subject_employee_id, leave_type,
      days, start_date, end_date, reason
    ) VALUES (
      ${sqlLiteral(randomUUID())}, ${sqlLiteral(ORG_ID)}, ${sqlLiteral(BRANCH_ID)},
      ${sqlLiteral(SEED_ACTOR_ID)}, ${sqlLiteral(approvedLeaveCandidateId)}, 'annual',
      1, ${sqlLiteral(todayValue)}::date, ${sqlLiteral(todayValue)}::date,
      ${sqlLiteral(`e2e candidate approved leave ${runId}`)}
    );
    UPDATE leave_requests
      SET status = 'approved', charge_state = 'legacy_unverified',
          charge_review_reasons = ARRAY[]::text[], charge_units = 1,
          decided_by = ${sqlLiteral(leaveDeciderId)}::uuid, decided_at = now()
      WHERE org_id = ${sqlLiteral(ORG_ID)}
        AND subject_employee_id = ${sqlLiteral(approvedLeaveCandidateId)}::uuid;

    INSERT INTO attendance_substitutions (
      id, org_id, site, branch_id, role, cover_date, from_minutes, to_minutes,
      covered_employee_id, reason_kind, reason_detail, worker_employee_id,
      worker_name, worker_type, status, idempotency_key, request_fingerprint, created_by
    ) VALUES (
      ${sqlLiteral(randomUUID())}, ${sqlLiteral(ORG_ID)}, 'E2E 현장', ${sqlLiteral(BRANCH_ID)}, '현장 지원',
      ${sqlLiteral(todayValue)}::date, 540, 1080, ${sqlLiteral(blockedEmployeeId)}, 'NO_SHOW',
      ${sqlLiteral(`e2e overlapping candidate ${runId}`)}, ${sqlLiteral(overlapCandidateId)},
      ${sqlLiteral(overlapCandidateName)}, 'REGULAR', 'ASSIGNED',
      ${sqlLiteral(`attendance-live-e2e-overlap-${runId}`)}, repeat('e', 64), ${sqlLiteral(SEED_ACTOR_ID)}::uuid
    );

    INSERT INTO employee_attendance_records (
      id, org_id, employee_id, actor_user_id, kind, occurred_at, work_date,
      state_after, idempotency_key
    ) VALUES ${clockRows};
    COMMIT;
  `;
  execSql(sql);
}

function seedMemberSelfServiceStory(): void {
  assertDevOnlyEnvironment();
  // Organizations are privileged provisioning data, so create this isolated
  // active tenant through the owner connection before using the runtime role
  // for the actual member facts under its tenant GUC.
  execOwnerSql(`
    BEGIN;
    SET LOCAL app.current_org = ${sqlLiteral(memberOrgId)};
    INSERT INTO organizations (id, slug, name, status)
    VALUES (${sqlLiteral(memberOrgId)}, ${sqlLiteral(memberOrgSlug)}, ${sqlLiteral(memberOrgName)}, 'ACTIVE');
    COMMIT;
  `);
  execSql(`
    BEGIN;
    SET LOCAL app.current_org = ${sqlLiteral(memberOrgId)};
    -- The MEMBER dev principal is identified by the deterministic phone the
    -- local dev-auth provisioner upserts. Preserve that row's employee link,
    -- while deliberately leaving both home_branch_id and user_branches empty:
    -- self-service must derive identity without a manager branch scope.
    INSERT INTO employees (
      id, org_id, company, name, source_filename, source_sheet, source_row,
      source_key, employment_status, org_unit, home_branch_id
    ) VALUES (
      ${sqlLiteral(memberEmployeeId)}, ${sqlLiteral(memberOrgId)}, 'E2E', ${sqlLiteral(memberEmployeeName)},
      'attendance-member-live-e2e', 'attendance', 99, ${sqlLiteral(`attendance-member-live-e2e-${runId}`)},
      'ACTIVE', 'E2E 본인 근태', NULL
    );
    INSERT INTO users (id, display_name, phone, roles, is_active, org_id, employee_id)
    VALUES (
      ${sqlLiteral(memberUserId)}, ${sqlLiteral(memberEmployeeName)}, ${sqlLiteral(memberPhone)},
      ARRAY['MEMBER'], true, ${sqlLiteral(memberOrgId)}, ${sqlLiteral(memberEmployeeId)}
    );
    INSERT INTO attendance_exceptions (
      id, org_id, code, kind, status, employee_id, branch_id, work_date,
      detail, evidence, links, idempotency_key, request_fingerprint, created_by
    ) VALUES (
      ${sqlLiteral(memberExceptionId)}, ${sqlLiteral(memberOrgId)}, ${sqlLiteral(memberExceptionCode)}, 'LATE', 'OPEN',
      ${sqlLiteral(memberEmployeeId)}, NULL, ${sqlLiteral(todayValue)}::date,
      ${sqlLiteral(memberExceptionDetail)}, ${sqlLiteral(JSON.stringify([{ name: memberEvidenceName, size: "24KB" }]))}::jsonb, '[]'::jsonb,
      ${sqlLiteral(`attendance-member-live-e2e-${runId}`)}, repeat('f', 64),
      (SELECT id FROM users WHERE phone = ${sqlLiteral(memberPhone)})
    );
    COMMIT;
  `);
}

function scalar(sql: string): string {
  return execSql(`BEGIN; SET LOCAL app.current_org = ${sqlLiteral(ORG_ID)}; ${sql}; COMMIT;`);
}

function memberScalar(sql: string): string {
  return execSql(`BEGIN; SET LOCAL app.current_org = ${sqlLiteral(memberOrgId)}; ${sql}; COMMIT;`);
}

async function loginAs(page: Page, role: DevRole): Promise<void> {
  await page.goto("/login");
  await page.getByRole("button", { name: /역할 전환 로그인/ }).click();
  await page.getByRole("combobox").selectOption({ label: role });
  await page.getByLabel("지점").selectOption(BRANCH_ID);
  await page.getByRole("button", { name: /로그인$/ }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

async function loginAsMemberWithoutBranch(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByRole("button", { name: /역할 전환 로그인/ }).click();
  await page.getByRole("combobox").selectOption({ label: "일반 멤버" });
  await page.getByRole("button", { name: "고급 설정" }).click();
  await page.getByLabel("조직 ID").fill(memberOrgId);
  await page.getByLabel("지점 ID (쉼표로 구분)").fill("");
  await expect(
    page.getByText("지점 ID를 비워두면 조직 전체 범위로 로그인합니다."),
  ).toBeVisible();
  await page.getByRole("button", { name: /로그인$/ }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
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

  // Every candidate comes from the real server-derived picker. The seed has
  // exactly one eligible employee and five same-name-family exclusions: another
  // branch, inactive employment, approved leave, open NO_SHOW, and an assigned
  // overlap. This exercises actual eligibility semantics without mocked transport.
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
  await substitutionDialog.getByLabel("이름 검색").fill("E2E 후보");
  await expect(
    substitutionDialog.getByText(eligibleCandidateName, { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  for (const excludedName of [
    wrongBranchCandidateName,
    inactiveCandidateName,
    approvedLeaveCandidateName,
    openNoShowCandidateName,
    overlapCandidateName,
  ]) {
    await expect(
      substitutionDialog.getByText(excludedName, { exact: true }),
    ).toHaveCount(0);
  }
  await substitutionDialog
    .getByLabel("이름 검색")
    .fill(eligibleCandidateName);
  const eligibleCandidate = substitutionDialog.getByRole("listitem", {
    name: new RegExp(eligibleCandidateName),
  });
  await expect(eligibleCandidate).toBeVisible({ timeout: 15_000 });
  await eligibleCandidate.getByRole("button", { name: "배정" }).click();
  await expect(substitutionDialog).toHaveCount(0, { timeout: 15_000 });

  const substitutionId = scalar(
    `SELECT id FROM attendance_substitutions WHERE org_id = ${sqlLiteral(ORG_ID)} AND exception_id = (SELECT id FROM attendance_exceptions WHERE org_id = ${sqlLiteral(ORG_ID)} AND code = ${sqlLiteral(coverExceptionCode)})`,
  );
  expect(substitutionId).toMatch(/^[0-9a-f-]{36}$/i);
  await expect
    .poll(() =>
      scalar(
        `SELECT concat_ws('|', status, worker_employee_id::text, worker_name, worker_type, coalesce(worker_rate, 'NULL')) FROM attendance_substitutions WHERE id = ${sqlLiteral(substitutionId)}`,
      ),
    )
    .toBe(
      `ASSIGNED|${eligibleCandidateId}|${eligibleCandidateName}|REGULAR|NULL`,
    );
  await expect
    .poll(() =>
      scalar(
        `SELECT count(*) FROM audit_events WHERE action = 'attendance.substitution.assign' AND target_id = ${sqlLiteral(substitutionId)}`,
      ),
    )
    .toBe("1");

  // Cancellation is a visible screen workflow, not a REST call; persist both
  // state and its corresponding immutable audit event.
  const cancellationButton = page.getByRole("button", { name: "대근 취소" });
  await expect(cancellationButton).toBeVisible({ timeout: 15_000 });
  await cancellationButton.click();
  const cancellationDialog = page.getByRole("dialog", {
    name: "대근 편성 취소",
  });
  await expect(cancellationDialog).toBeVisible();
  await cancellationDialog
    .getByLabel("취소 사유")
    .fill(`e2e coverage no longer required ${runId}`);
  await cancellationDialog.getByRole("button", { name: "대근 취소" }).click();
  await expect(cancellationDialog).toHaveCount(0, { timeout: 15_000 });
  await expect
    .poll(() =>
      scalar(
        `SELECT status FROM attendance_substitutions WHERE id = ${sqlLiteral(substitutionId)}`,
      ),
    )
    .toBe("CANCELLED");
  await expect
    .poll(() =>
      scalar(
        `SELECT count(*) FROM audit_events WHERE action = 'attendance.substitution.cancel' AND target_id = ${sqlLiteral(substitutionId)}`,
      ),
    )
    .toBe("1");

  // Move to the isolated future month. This avoids unrelated current-month
  // leave data while exercising the same server-derived close preflight.
  await page.getByRole("button", { name: "월간" }).click();
  await page.getByRole("button", { name: "다음 달" }).click();
  await expect(
    page.getByText(`${closeYear}년 ${closeMonthNumber}월`),
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
  const exceptionDialog = page.getByRole("dialog", {
    name: "근태 예외 상세",
  });
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

  // Amendment is also a real post-close UI flow; the dialog preserves the
  // correction rationale and reference as an immutable persisted amendment.
  const amendmentButton = page.getByRole("button", { name: "소급 보정" });
  await expect(amendmentButton).toBeVisible({ timeout: 15_000 });
  await amendmentButton.click();
  const amendmentDialog = page.getByRole("dialog", {
    name: "마감 소급 보정",
  });
  await expect(amendmentDialog).toBeVisible();
  await amendmentDialog
    .getByLabel("보정 사유")
    .fill("e2e verified late evidence");
  await amendmentDialog
    .getByLabel("보정 내용")
    .fill(`post-close evidence receipt ${runId}`);
  await amendmentDialog.getByLabel("연결 참조").fill(`E2E-${runId}`);
  await amendmentDialog.getByRole("button", { name: "저장" }).click();
  await expect(amendmentDialog).toHaveCount(0, { timeout: 15_000 });
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

});

test.describe("ATTENDANCE-31 live MEMBER self-service story", () => {
  test.beforeAll(() => {
    seedMemberSelfServiceStory();
  });

  test("ATTENDANCE-31 MEMBER reads only their linked attendance without a branch", async ({
    page,
  }) => {
    const consoleGuard = attachConsoleGuard(page);
    const ownAttendanceRequests: URL[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET") return;
      const url = new URL(request.url());
      if (
        url.pathname === "/api/v1/attendance/me/exceptions" ||
        url.pathname === "/api/v1/attendance/me/week52"
      ) {
        ownAttendanceRequests.push(url);
      }
    });
    await loginAsMemberWithoutBranch(page);
    expect(
      memberScalar(
        `SELECT employee_id::text FROM users WHERE phone = ${sqlLiteral(memberPhone)}`,
      ),
    ).toBe(memberEmployeeId);
    expect(
      memberScalar(
        `SELECT count(*) FROM user_branches WHERE user_id = (SELECT id FROM users WHERE phone = ${sqlLiteral(memberPhone)})`,
      ),
    ).toBe("0");
    await page.goto("/attendance");
    await expect(page).toHaveURL(/\/attendance(?:$|[?#])/, {
      timeout: 15_000,
    });
    const selfService = page.getByLabel("내 근태");
    await expect(selfService).toBeVisible({ timeout: 15_000 });
    await expect(
      selfService.getByRole("button", { name: new RegExp(memberExceptionDetail) }),
    ).toBeVisible({ timeout: 15_000 });
    // The linked active employee has no punches: a zero-hour projection is
    // available, not the unlinked principal's unavailable state.
    await expect(selfService.getByText(/0\.0시간/)).toBeVisible();
    await expect(
      selfService.getByText("현재 주간 근태 집계가 연결되지 않았습니다."),
    ).toHaveCount(0);

    expect(ownAttendanceRequests.map((url) => url.pathname)).toEqual(
      expect.arrayContaining([
        "/api/v1/attendance/me/exceptions",
        "/api/v1/attendance/me/week52",
      ]),
    );
    for (const url of ownAttendanceRequests) {
      for (const selector of [
        "employee_id",
        "branch_id",
        "actor_id",
        "manager_id",
        "org_id",
      ]) {
        expect(url.searchParams.has(selector), `${url} leaked ${selector}`).toBe(false);
      }
    }

    await selfService
      .getByRole("button", { name: new RegExp(memberExceptionDetail) })
      .click();
    const detail = page.getByRole("dialog", { name: "예외 상세" });
    await expect(detail).toBeVisible();
    await expect(detail.getByText(memberExceptionDetail, { exact: true })).toBeVisible();
    await expect(detail.getByText(memberEvidenceName, { exact: false })).toBeVisible();
    await expect(detail.getByText(memberExceptionId, { exact: true })).toHaveCount(0);
    await expect(detail.getByLabel("처리 사유")).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "확인 처리" })).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "대근 편성" })).toHaveCount(0);

    // The same signed MEMBER principal becomes unlinked after its first real
    // self-service read. A document reload must render the strict unavailable
    // Week52 envelope rather than retaining the prior projection.
    expect(
      memberScalar(
        `UPDATE users SET employee_id = NULL WHERE phone = ${sqlLiteral(memberPhone)} RETURNING id::text`,
      ),
    ).toMatch(/^[0-9a-f-]{36}$/i);
    const unlinkedWeek52Response = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/api/v1/attendance/me/week52",
    );
    await page.reload();
    const week52Response = await unlinkedWeek52Response;
    expect(week52Response.status()).toBe(200);
    const unlinkedWeek52 = await week52Response.json();
    expect(unlinkedWeek52).toEqual({ status: "not_available" });
    expect(unlinkedWeek52).not.toHaveProperty("projection");
    await expect(
      page.getByText("현재 주간 근태 집계가 연결되지 않았습니다."),
    ).toBeVisible({ timeout: 15_000 });
    await assertNoRawI18nKeys(page);
    await assertNoAxeViolations(page, {
      context: "attendance MEMBER self-service linkage and unavailable states",
    });
    consoleGuard.assertClean();
  });
});
