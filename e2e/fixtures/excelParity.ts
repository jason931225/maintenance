import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type ExcelParityCompany = {
  sheet: string;
  company: string;
  expected_employee_count: number;
  expected_named_count: number;
  source_template_row_count: number;
  first_name: string | null;
  first_name_source_row: number | null;
  last_name: string | null;
  last_name_source_row: number | null;
};

export type ExcelParityExpectations = {
  source: string;
  source_sha256: string;
  row_rule: string;
  companies: ExcelParityCompany[];
  cp949_csv_evidence?: {
    path: string;
    encoding_written: string;
    encoding_read_label: string;
    sha256: string;
    byte_count: number;
    row_count_including_header: number;
    headers: string[];
    replacement_character_count: number;
  };
};

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
const script = resolve(repoRoot, "scripts/derive_excel_browser_parity.py");

export const workbookPath =
  process.env.E2E_EXCEL_PARITY_WORKBOOK ??
  "/Users/jasonlee/Downloads/Untitled spreadsheet.xlsx";

export function loadExcelParityExpectations(): ExcelParityExpectations {
  const dir = mkdtempSync(join(tmpdir(), "excel-parity-"));
  const args = [
    script,
    "--workbook",
    workbookPath,
    "--cp949-csv",
    join(dir, "org-cp949.csv"),
  ];
  return JSON.parse(execFileSync("python3", args, { encoding: "utf8" }));
}

export function workbookAvailable(): boolean {
  return existsSync(workbookPath);
}
