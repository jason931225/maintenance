import { test, expect } from "../fixtures/roles";
import {
  loadExcelParityExpectations,
  workbookAvailable,
  workbookPath,
} from "../fixtures/excelParity";

const enabled = process.env.E2E_EXCEL_PARITY === "1";
const dataExchangeUrl = process.env.E2E_DATA_EXCHANGE_URL ?? "/settings/employees";

async function findImportInput(page: import("@playwright/test").Page) {
  const input = page
    .locator(
      [
        '[data-testid="excel-import-file"]',
        '[data-testid="data-exchange-file-input"]',
        'input[type="file"][accept*="xlsx"]',
        'input[type="file"]',
      ].join(", "),
    )
    .first();
  await expect(input).toBeAttached({ timeout: 10_000 });
  return input;
}

async function submitImport(page: import("@playwright/test").Page) {
  const button = page.getByRole("button", {
    name: /가져오기|업로드|불러오기|Import|Upload/i,
  });
  if (await button.first().isVisible().catch(() => false)) {
    await button.first().click();
  }
}

async function selectCompany(page: import("@playwright/test").Page, company: string) {
  const option = page.getByRole("option", { name: company });
  const combo = page.getByRole("combobox", { name: /회사|소속|조직|Company/i });
  if (await combo.first().isVisible().catch(() => false)) {
    await combo.first().selectOption({ label: company }).catch(async () => {
      await combo.first().click();
      await option.click();
    });
    return;
  }
  await page.getByRole("button", { name: company }).click();
}

async function visibleTableRows(page: import("@playwright/test").Page) {
  return page.locator("table tbody tr").filter({ hasNotText: /^\s*$/ });
}

test("Excel parity source expectations are derivable and CP949 org CSV decodes without replacement characters", async () => {
  test.skip(!workbookAvailable(), `missing workbook: ${workbookPath}`);
  const expectations = loadExcelParityExpectations();

  expect(expectations.companies.map((company) => company.company)).toEqual([
    "(주)디에스엘",
    "(주)코스",
    "(주)엘소",
    "(주)케이앤엘",
    "(주)청운로지스",
    "(주)씨앤엘",
    "(주)청운HR",
    "제이와이테크",
  ]);
  expect(expectations.companies.map((company) => company.expected_employee_count)).toEqual([
    13, 96, 139, 4, 1, 43, 22, 11,
  ]);
  expect(expectations.companies.map((company) => company.source_template_row_count)).toEqual([
    95, 96, 139, 68, 68, 68, 62, 11,
  ]);

  const cp949 = expectations.cp949_csv_evidence;
  expect(cp949?.encoding_read_label).toBe("euc-kr");
  expect(cp949?.headers).toEqual(["회사명", "부서명", "이름"]);
  expect(cp949?.replacement_character_count).toBe(0);
});

test("admin console imports the workbook and each company filter matches Excel counts and names", async ({
  page,
  loginAs,
}) => {
  test.skip(!enabled, "set E2E_EXCEL_PARITY=1 to mutate the local e2e database with workbook employee rows");
  test.skip(!workbookAvailable(), `missing workbook: ${workbookPath}`);

  const expectations = loadExcelParityExpectations();
  await loginAs("SUPER_ADMIN");
  await page.goto(dataExchangeUrl);

  await (await findImportInput(page)).setInputFiles(workbookPath);
  await submitImport(page);
  const totalEmployees = expectations.companies.reduce(
    (total, company) => total + company.expected_employee_count,
    0,
  );
  await expect(
    page.getByText(new RegExp(`${totalEmployees}\\s*/\\s*${totalEmployees}`)),
  ).toBeVisible({ timeout: 30_000 });

  for (const company of expectations.companies) {
    await selectCompany(page, company.company);
    const rows = await visibleTableRows(page);
    await expect(rows).toHaveCount(company.expected_employee_count);
    if (company.first_name) {
      await expect(page.getByText(company.first_name, { exact: true })).toBeVisible();
    }
    if (company.last_name) {
      await expect(page.getByText(company.last_name, { exact: true })).toBeVisible();
    }
  }
});
