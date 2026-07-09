import { createTextGate } from "./lib/text-gate.mjs";

const { requireIncludes, requireAbsent, reportGate } = createTextGate({
  includeFailure: ({ path, needle, label }) => `${path} is missing ${label}: ${needle}`,
  absentFailure: ({ path, label }) => `${path} still contains ${label}`,
  passLabel: (label, kind) => `${label} ${kind === "absent" ? "absent" : "present"}`,
});

requireIncludes(
  "web/src/pages/EmployeesPage.tsx",
  "function PeopleOperationsPanel",
  "people operations command panel",
);
requireIncludes(
  "web/src/pages/EmployeesPage.tsx",
  'to="/settings/users"',
  "user provisioning link",
);
requireIncludes(
  "web/src/pages/EmployeesPage.tsx",
  'to="/settings/policy"',
  "policy management link",
);
requireIncludes(
  "web/src/pages/EmployeesPage.tsx",
  'to="/settings/workflows"',
  "workflow management link",
);
requireIncludes(
  "web/src/pages/EmployeesPage.tsx",
  "body.to_company = trimmedOrNull(toCompany)",
  "transfer target company submission",
);
requireIncludes(
  "web/src/pages/EmployeesPage.tsx",
  "body.to_org_unit = trimmedOrNull(toOrgUnit)",
  "transfer target org-unit submission",
);
requireIncludes(
  "web/src/pages/EmployeesPage.tsx",
  "body.to_position = trimmedOrNull(toPosition)",
  "transfer target position submission",
);
requireIncludes(
  "web/src/pages/EmployeesPage.tsx",
  "event.signoffs[key] ? t.confirmed : t.notConfirmed",
  "visible lifecycle signoff history",
);

requireIncludes(
  "web/src/pages/EmployeesPage.test.tsx",
  "captures transfer targets and shows signoff history",
  "transfer role-story test",
);
requireIncludes(
  "web/src/pages/EmployeesPage.test.tsx",
  "피플 운영 관제",
  "people operations panel test",
);
requireIncludes(
  "web/src/pages/EmployeesPage.test.tsx",
  'to_company: "한울로지스"',
  "transfer company request assertion",
);
requireIncludes(
  "web/src/pages/EmployeesPage.test.tsx",
  'to_org_unit: "운영기획팀"',
  "transfer org-unit request assertion",
);
requireIncludes(
  "web/src/pages/EmployeesPage.test.tsx",
  'to_position: "차장"',
  "transfer position request assertion",
);

requireIncludes(
  "backend/app/src/hr.rs",
  "cross-company transfer requires payroll cutoff and retirement-settlement signoffs",
  "backend transfer payroll/severance guard",
);
requireIncludes(
  "backend/openapi/openapi.yaml",
  "Record an employee lifecycle transition with legal signoffs",
  "OpenAPI lifecycle signoff contract",
);
requireIncludes(
  "docs/specs/data-exchange-import-export.md",
  "Do **not** coerce payroll, bank/account, resident registration number, disability status, or retirement-settlement fields into general `users` columns",
  "payroll-sensitive import boundary",
);
requireIncludes(
  "docs/benchmarks/enterprise-ui-route-audit.json",
  "G004-identity-group-org-people-policy-fou",
  "G004 ownership in enterprise UI audit",
);

requireAbsent(
  "web/src/pages/EmployeesPage.tsx",
  /(준비 후 허용|아직 제공되지|placeholder|TODO|demo)/i,
  "dead/demo HR product copy",
);

reportGate("people HR maturity gate passed");
