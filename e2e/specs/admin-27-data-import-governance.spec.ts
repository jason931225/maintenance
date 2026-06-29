import { execFileSync } from "node:child_process";
import { basename } from "node:path";

import { test, expect, querySql, TENANT_ORG_ID } from "../fixtures/roles";

function writeWorkbook(path: string, employeeName: string): void {
  execFileSync(
    "python3",
    [
      "-c",
      `
import sys
from openpyxl import Workbook

path, employee_name = sys.argv[1], sys.argv[2]
wb = Workbook()
ws = wb.active
ws.title = "코스"
ws.append(["성명", "사번", "계좌번호", "근무지\\n(주소)", "메모"])
ws.append([employee_name, "G005-001", "123-456-7890", "서울", "현장 배치"])
ws.append(["", "", "빈 이름 원천 행", "", "보존"])
wb.save(path)
`,
      path,
      employeeName,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
}

async function bearerToken(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/auth/token/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Transport": "cookie",
      },
      credentials: "include",
      body: "{}",
    });
    const body = (await response.json()) as { access_token?: string };
    return body.access_token ?? "";
  });
}

test("ADMIN-27 governed employee import preserves raw rows, masks sensitive preview, dry-runs, applies, and exports canonical CSV", async ({
  page,
  loginAs,
}, testInfo) => {
  const suffix = Date.now().toString(36);
  const employeeName = `G005홍길동${suffix}`;
  const workbook = testInfo.outputPath(`g005-${suffix}.xlsx`);
  const filename = basename(workbook);
  writeWorkbook(workbook, employeeName);

  await loginAs("SUPER_ADMIN");
  await page.goto("/settings/employees");
  await page.getByTestId("excel-import-file").setInputFiles(workbook);
  await page.getByRole("button", { name: "미리보기 생성" }).click();

  await expect(page.getByRole("heading", { name: "가져오기 검토" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("계좌번호").first()).toBeVisible();
  await expect(page.getByText("••••").first()).toBeVisible();

  await page.getByRole("button", { name: "드라이런" }).click();
  await expect(page.getByText("추가 예정")).toBeVisible({ timeout: 20_000 });
  expect(
    querySql<{ employee_rows: number }>(
      `SELECT COUNT(*)::int AS employee_rows
         FROM employees
        WHERE org_id = '${TENANT_ORG_ID}'
          AND source_filename = '${filename}'`,
    ),
  ).toEqual([{ employee_rows: 0 }]);

  const ledgerRows = querySql<{ runs: number; raw_rows: number; candidate_rows: number }>(
    `SELECT COUNT(DISTINCT r.id)::int AS runs,
            COUNT(ir.id)::int AS raw_rows,
            COUNT(ir.id) FILTER (WHERE ir.row_status = 'CANDIDATE')::int AS candidate_rows
       FROM data_import_runs r
       JOIN data_import_rows ir ON ir.run_id = r.id AND ir.org_id = r.org_id
      WHERE r.org_id = '${TENANT_ORG_ID}'
        AND r.source_filename = '${filename}'`,
  );
  expect(ledgerRows).toEqual([{ runs: 1, raw_rows: 2, candidate_rows: 1 }]);

  await page.getByRole("button", { name: "검토 후 적용" }).click();
  await expect(page.getByText(employeeName, { exact: true })).toBeVisible({
    timeout: 20_000,
  });

  expect(
    querySql<{ employee_rows: number }>(
      `SELECT COUNT(*)::int AS employee_rows
         FROM employees
        WHERE org_id = '${TENANT_ORG_ID}'
          AND source_filename = '${filename}'
          AND name = '${employeeName}'`,
    ),
  ).toEqual([{ employee_rows: 1 }]);

  const token = await bearerToken(page);
  expect(token.length).toBeGreaterThan(20);
  const exportResponse = await page.request.get("/api/v1/employees/export.csv", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(exportResponse.status()).toBe(200);
  const csv = await exportResponse.text();
  expect(csv).toContain(employeeName);
  expect(csv).not.toContain("123-456-7890");
  expect(csv).not.toContain("계좌번호");
});
