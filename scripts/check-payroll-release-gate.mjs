import { createTextGate } from "./lib/text-gate.mjs";

const { requireIncludes, requireMatches, requireAbsent, reportGate } = createTextGate({
  includeFailure: ({ path, needle, label }) => `${path} is missing ${label}: ${needle}`,
  matchFailure: ({ path, pattern, label }) => `${path} does not satisfy ${label}: ${pattern}`,
  absentFailure: ({ path, pattern, label }) => `${path} violates ${label}: ${pattern}`,
  passLabel: (label, kind) => `${label} ${kind === "absent" ? "absent" : "present"}`,
});

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
  "Payroll readiness is high-sensitivity",
  "navigation separates payroll readiness from finance",
);
requireIncludes(
  "web/src/AppRouter.tsx",
  'itemKey="payroll"',
  "payroll route uses nav-item authorization",
);
requireIncludes(
  "web/src/AppRouter.tsx",
  'path="/payroll"',
  "payroll readiness route",
);
requireMatches(
  "web/src/pages/PayrollPage.tsx",
  /\.GET\(\s*"\/api\/v1\/hr\/readiness-summary"/,
  "payroll readiness summary read path",
);
requireIncludes(
  "web/src/pages/PayrollPage.tsx",
  "calculation_enabled_runs",
  "payroll calculation readiness gate surfaced",
);
requireIncludes(
  "web/src/pages/PayrollPage.tsx",
  "copy.status.blocked",
  "payroll page defaults to legal blocked status",
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
  "web/src/pages/PayrollPage.tsx",
  /\.(POST|PUT|PATCH|DELETE)\(/,
  "payroll readiness page mutation API calls",
);
requireAbsent(
  "web/src/pages/EmployeesPage.tsx",
  /(월급|급여액|기본시급|통상시급|계좌번호|주민번호)/,
  "generic HR page raw payroll/bank/resident fields",
);

reportGate("payroll release gate check passed");
