import { readFileSync } from "node:fs";

const checks = [];

function read(path) {
  return readFileSync(path, "utf8");
}

function requireIncludes(path, needle, label) {
  const source = read(path);
  if (!source.includes(needle)) {
    throw new Error(`${path} is missing ${label}: ${needle}`);
  }
  checks.push(`${label} present`);
}

function requireMatches(path, pattern, label) {
  const source = read(path);
  if (!pattern.test(source)) {
    throw new Error(`${path} does not satisfy ${label}: ${pattern}`);
  }
  checks.push(`${label} present`);
}

function requireAbsent(path, pattern, label) {
  const source = read(path);
  if (pattern.test(source)) {
    throw new Error(`${path} violates ${label}: ${pattern}`);
  }
  checks.push(`${label} absent`);
}

requireIncludes(
  "docs/specs/payroll.md",
  "Status: first regulated-kernel slice",
  "regulated payroll spec status",
);
requireIncludes(
  "docs/specs/payroll.md",
  "Production payroll calculations are disabled unless all are true",
  "production payroll release gate",
);
requireIncludes(
  "docs/specs/payroll.md",
  "G028 production-control contract",
  "G028 production-control contract",
);
requireIncludes(
  "docs/specs/payroll.md",
  "generic employee import/export can only preview masked values",
  "generic HR payroll masking rule",
);
requireIncludes(
  "docs/specs/payroll.md",
  "payroll/wage-statement mail may exist as an audited work-mail object",
  "payroll receipt mail boundary",
);
requireIncludes(
  "docs/specs/payroll.md",
  "passkey step-up",
  "payroll signing-equivalent step-up rule",
);

requireIncludes(
  "backend/crates/payroll/domain/src/lib.rs",
  "This crate intentionally contains pure, source-versioned data and guardrail",
  "pure payroll kernel boundary",
);
requireIncludes(
  "backend/crates/payroll/domain/src/lib.rs",
  "NTS withholding tax table row is required; payroll must not estimate income tax",
  "no estimated income tax path",
);
requireIncludes(
  "backend/crates/payroll/domain/src/lib.rs",
  "노무사/세무사 professional validation is required",
  "professional validation fail-closed gate",
);
requireIncludes(
  "backend/crates/payroll/domain/src/lib.rs",
  "at least one payroll golden case is required",
  "golden case release gate",
);
requireIncludes(
  "backend/crates/payroll/domain/src/lib.rs",
  "artifact_sha256 must be a 64-character hex digest",
  "professional artifact digest validation",
);

requireIncludes(
  "web/src/components/shell/nav.ts",
  "Payroll remains a separate high-sensitivity",
  "navigation does not mislabel finance as payroll",
);
requireIncludes(
  "web/src/pages/EmployeesPage.test.tsx",
  "기본시급",
  "payroll wage column masking test",
);
requireIncludes(
  "web/src/pages/EmployeesPage.test.tsx",
  "퇴직금 중간정산",
  "severance interim-settlement masking test",
);
requireIncludes(
  "web/src/pages/EmployeesPage.test.tsx",
  "queryByText(\"12345\")",
  "raw payroll amount non-render assertion",
);
requireIncludes(
  "web/src/pages/EmployeesPage.test.tsx",
  "queryByText(\"2025-12-31\")",
  "raw severance date non-render assertion",
);
requireIncludes(
  "web/src/pages/MailPage.test.tsx",
  "급여명세서 확인",
  "payroll receipt mail workflow test fixture",
);

requireMatches(
  "package.json",
  /"check:payroll"\s*:\s*"node scripts\/check-payroll-domain\.mjs"/,
  "payroll domain script",
);
requireMatches(
  "package.json",
  /"check:payroll-release-gate"\s*:\s*"node scripts\/check-payroll-release-gate\.mjs"/,
  "payroll release-gate script",
);
requireIncludes(
  ".github/workflows/ci.yml",
  "npm run check:payroll-release-gate",
  "CI payroll release-gate wiring",
);

requireAbsent(
  "web/src/AppRouter.tsx",
  /path=\"\/payroll\"|path=\"payroll\"/,
  "payroll route before release gate",
);
requireAbsent(
  "web/src/pages/EmployeesPage.tsx",
  /(월급|급여액|기본시급|통상시급|계좌번호|주민번호)/,
  "generic HR page raw payroll/bank/resident fields",
);

console.log(`payroll release gate check passed (${checks.length} checks)`);
