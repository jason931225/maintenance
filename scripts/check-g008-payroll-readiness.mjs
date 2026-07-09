import { createTextGate } from "./lib/text-gate.mjs";

const { requireIncludes, requireMatches, requireNotIncludes, reportGate } = createTextGate();

requireIncludes(
  "docs/specs/hr-payroll-readiness.md",
  "Payroll calculation remains blocked until the release gate is professionally validated",
  "payroll readiness spec keeps regulated calculation blocked",
);
requireIncludes(
  "docs/specs/hr-payroll-readiness.md",
  "annual-leave usage-promotion workflow",
  "annual leave usage-promotion workflow is modeled",
);
requireIncludes(
  "docs/specs/hr-payroll-readiness.md",
  "messenger/mail/workflow notification is a workflow object",
  "future notification integration routes through workflow/comms objects",
);

requireIncludes(
  "backend/crates/platform/db/migrations/0074_create_payroll_readiness.sql",
  "CREATE TABLE payroll_draft_runs",
  "payroll draft run table exists",
);
requireIncludes(
  "backend/crates/platform/db/migrations/0074_create_payroll_readiness.sql",
  "CREATE TABLE payroll_draft_lines",
  "payroll draft line table exists",
);
requireIncludes(
  "backend/crates/platform/db/migrations/0074_create_payroll_readiness.sql",
  "CREATE TABLE annual_leave_obligations",
  "annual leave obligation table exists",
);
requireIncludes(
  "backend/crates/platform/db/migrations/0074_create_payroll_readiness.sql",
  "BLOCKED_LEGAL_GATE",
  "draft lines fail closed behind legal gate",
);
requireIncludes(
  "backend/crates/platform/db/migrations/0074_create_payroll_readiness.sql",
  "FORCE ROW LEVEL SECURITY",
  "payroll readiness tables force RLS",
);
requireIncludes(
  "backend/crates/platform/db/migrations/0074_create_payroll_readiness.sql",
  "GRANT SELECT, INSERT, UPDATE ON payroll_draft_runs TO mnt_rt",
  "runtime grants are explicit for draft runs",
);

requireIncludes(
  "scripts/stage_coss_group_payroll_readiness.sql",
  "COSS Group 2026-05 live import",
  "live import source label is explicit",
);
requireIncludes(
  "scripts/stage_coss_group_payroll_readiness.sql",
  "data_import_rows",
  "stage SQL derives from governed import ledger",
);
requireIncludes(
  "scripts/stage_coss_group_payroll_readiness.sql",
  "Payroll calculation remains blocked until an official NTS row and professional validation are attached",
  "stage SQL does not enable payable payroll",
);
requireIncludes(
  "scripts/stage_coss_group_payroll_readiness.sql",
  "annual_leave_obligations",
  "stage SQL creates annual leave review obligations",
);
requireIncludes(
  "scripts/stage_coss_group_payroll_readiness.sql",
  "data_import.payroll_readiness_stage",
  "stage SQL audits the live derivation",
);
requireMatches(
  "scripts/stage_coss_group_payroll_readiness.sql",
  /raw_row\?\|array\[/,
  "stage SQL classifies payroll/attendance source rows by allowlisted headers",
);
requireNotIncludes(
  "scripts/stage_coss_group_payroll_readiness.sql",
  "SELECT *",
  "stage SQL avoids broad raw selects",
);

requireIncludes(
  "package.json",
  '"check:g008-payroll-readiness"',
  "package script is wired",
);
requireIncludes(
  ".github/workflows/ci.yml",
  "npm run check:g008-payroll-readiness",
  "CI runs G008 payroll readiness gate",
);

reportGate("G008 payroll readiness gate passed");
