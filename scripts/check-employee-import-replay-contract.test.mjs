import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function between(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return text.slice(startIndex, endIndex);
}

test("employee import replay accounting is required in OpenAPI and every typed client", () => {
  const openapi = read("backend/openapi/openapi.yaml");
  for (const schema of [
    between(openapi, "    EmployeeImportCompanySummary:\n", "    EmployeeImportColumn:\n"),
    between(openapi, "    EmployeeImportReport:\n", "    HrOrgChartEmployee:\n"),
  ]) {
    assert.match(schema, /required:\n(?:      - [^\n]+\n)*      - skipped\n/);
    assert.match(schema, /        skipped:\n          type: integer\n          minimum: 0\n/);
  }

  const typescript = read("clients/ts/src/schema.d.ts");
  const tsCompany = between(
    typescript,
    "        EmployeeImportCompanySummary: {\n",
    "        EmployeeImportColumn: {\n",
  );
  const tsReport = between(
    typescript,
    "        EmployeeImportReport: {\n",
    "        HrOrgChartEmployee: {\n",
  );
  assert.match(tsCompany, /            skipped: number;\n/);
  assert.match(tsReport, /            skipped: number;\n/);

  const kotlinCompany = read(
    "clients/kotlin/src/main/kotlin/com/maintenance/api/client/model/EmployeeImportCompanySummary.kt",
  );
  const kotlinReport = read(
    "clients/kotlin/src/main/kotlin/com/maintenance/api/client/model/EmployeeImportReport.kt",
  );
  assert.match(kotlinCompany, /val skipped: kotlin\.Int/);
  assert.match(kotlinReport, /val skipped: kotlin\.Int/);

  const swift = read("clients/swift/Sources/MaintenanceAPIClient/Generated/Types.swift");
  const swiftCompany = between(
    swift,
    "        public struct EmployeeImportCompanySummary:",
    "        public struct EmployeeImportColumn:",
  );
  const swiftReport = between(
    swift,
    "        public struct EmployeeImportReport:",
    "        public struct HrOrgChartEmployee:",
  );
  assert.match(swiftCompany, /public var skipped: Swift\.Int/);
  assert.match(swiftReport, /public var skipped: Swift\.Int/);
});
