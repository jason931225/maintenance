#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const matrixPath = "docs/benchmarks/g005-workflow-lifecycle-matrix.json";
const auditPath = "docs/benchmarks/enterprise-ui-route-audit.json";
const goalId = "G005-workflow-builder-approvals-work-hub";
const failures = [];
const passes = [];

function pathOf(path) {
  return resolve(root, path);
}

function read(path) {
  const abs = pathOf(path);
  if (!existsSync(abs)) {
    failures.push(`${path}: missing`);
    return "";
  }
  return readFileSync(abs, "utf8");
}

function parseJson(path) {
  const text = read(path);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    failures.push(`${path}: invalid JSON: ${error.message}`);
    return null;
  }
}

function pass(label) {
  passes.push(label);
}

function assert(condition, ok, failure) {
  if (condition) pass(ok);
  else failures.push(failure);
}

function requireFile(path, label = path) {
  assert(existsSync(pathOf(path)), `${label}: present`, `${label}: missing (${path})`);
}

function requireIncludes(path, needle, label) {
  const text = read(path);
  assert(text.includes(needle), label, `${label}: ${path} must include ${JSON.stringify(needle)}`);
}

function requireNotIncludes(path, needle, label) {
  const text = read(path);
  assert(!text.includes(needle), label, `${label}: ${path} must not include ${JSON.stringify(needle)}`);
}

function requireArrayOfStrings(value, path, label) {
  assert(
    Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.length > 0),
    label,
    `${path}: ${label} must be a non-empty string array`,
  );
}

const matrix = parseJson(matrixPath);
const routeAudit = parseJson(auditPath);
const packageJson = parseJson("package.json") ?? {};
const ci = read(".github/workflows/ci.yml");

assert(
  packageJson.scripts?.["check:g005-workflow-lifecycle"] === "node scripts/check-g005-workflow-lifecycle.mjs",
  "package script check:g005-workflow-lifecycle",
  "package.json must define check:g005-workflow-lifecycle",
);
assert(
  ci.includes("npm run check:g005-workflow-lifecycle"),
  "CI runs G005 workflow lifecycle gate",
  ".github/workflows/ci.yml must run npm run check:g005-workflow-lifecycle",
);
requireFile(matrixPath, "G005 workflow lifecycle matrix");
requireFile(auditPath, "enterprise UI route audit register");
requireFile("e2e/specs/platform-maturity-g005-workflow-lifecycle.spec.ts", "G005 Playwright matrix contract spec");

if (matrix) {
  assert(matrix.schemaVersion === 1, "G005 matrix schema version 1", `${matrixPath}: schemaVersion must be 1`);
  assert(matrix.goalId === goalId, "G005 matrix goal id", `${matrixPath}: goalId must be ${goalId}`);
  assert(
    typeof matrix.nonClaimPolicy === "string" && matrix.nonClaimPolicy.includes("G009"),
    "G005 matrix records live-evidence non-claim policy",
    `${matrixPath}: nonClaimPolicy must reserve live rollout/screenshot claims for G009`,
  );
  assert(Array.isArray(matrix.routePaths) && matrix.routePaths.length >= 6, "G005 matrix routePaths", `${matrixPath}: routePaths must cover workflow routes`);
  assert(Array.isArray(matrix.dependencyRoutes) && matrix.dependencyRoutes.length >= 3, "G005 matrix dependency routePaths", `${matrixPath}: dependencyRoutes must cover downstream route dependencies`);
  requireArrayOfStrings(matrix.requiredE2eSpecs, matrixPath, "requiredE2eSpecs");
  requireArrayOfStrings(matrix.requiredWebTests, matrixPath, "requiredWebTests");
  requireArrayOfStrings(matrix.requiredBackendTests, matrixPath, "requiredBackendTests");
  assert(Array.isArray(matrix.backendContracts) && matrix.backendContracts.length >= 9, "G005 backend contract inventory", `${matrixPath}: backendContracts must include workflow/approval/evidence contracts`);
  assert(Array.isArray(matrix.frontendContracts) && matrix.frontendContracts.length >= 8, "G005 frontend contract inventory", `${matrixPath}: frontendContracts must include workflow/work hub/approval/work-order surfaces`);
  assert(Array.isArray(matrix.safetyAssertions) && matrix.safetyAssertions.length >= 10, "G005 safety assertions", `${matrixPath}: safetyAssertions must capture workflow, approval, evidence, badge, and scope guardrails`);

  const requiredRouteGroups = new Set(["work-hub", "approvals", "workflow-builder", "work-order-detail", "intake", "planned-work"]);
  const matrixRoutes = new Map();
  for (const row of matrix.routePaths ?? []) {
    assert(typeof row.path === "string" && row.path.startsWith("/"), `G005 route ${row.path ?? "<missing>"}: path`, `${matrixPath}: route row missing path`);
    assert(row.mustContainOwnerGoal === "G005", `G005 route ${row.path}: owner marker`, `${matrixPath}: route ${row.path} mustContainOwnerGoal must be G005`);
    assert(typeof row.requiredStory === "string" && row.requiredStory.length >= 48, `G005 route ${row.path}: required story`, `${matrixPath}: route ${row.path} requiredStory is too weak`);
    matrixRoutes.set(row.path, row);
  }
  for (const group of requiredRouteGroups) {
    assert([...matrixRoutes.values()].some((row) => row.routeGroup === group), `G005 route group ${group}: covered`, `${matrixPath}: no route covers group ${group}`);
  }

  if (routeAudit?.routeCoverage) {
    const auditByPath = new Map(routeAudit.routeCoverage.map((row) => [row.canonicalPath, row]));
    const ownedG005Rows = routeAudit.routeCoverage.filter((row) => String(row.ownerLane ?? "").startsWith("G005"));
    assert(ownedG005Rows.length >= 6, "enterprise route audit has G005-owned rows", `${auditPath}: expected G005-owned route rows`);
    for (const auditRow of ownedG005Rows) {
      assert(matrixRoutes.has(auditRow.canonicalPath), `route audit ${auditRow.canonicalPath}: represented in G005 matrix`, `${matrixPath}: missing routePaths row for G005-owned route ${auditRow.canonicalPath}`);
    }
    const weakNeedles = ["fallback", "unclassified", "demo", "placeholder", "coming soon", "black background", "text wall"];
    for (const [path, matrixRow] of matrixRoutes) {
      const auditRow = auditByPath.get(path);
      assert(Boolean(auditRow), `G005 matrix route ${path}: exists in route audit`, `${auditPath}: missing routeCoverage for ${path}`);
      if (!auditRow) continue;
      assert(String(auditRow.ownerLane ?? "").includes("G005"), `G005 matrix route ${path}: ownerLane contains G005`, `${auditPath}: ${path} ownerLane must include G005`);
      assert(String(auditRow.e2eSpec ?? "").includes("Required browser"), `G005 matrix route ${path}: browser story required`, `${auditPath}: ${path} e2eSpec must require browser story`);
      assert(String(auditRow.e2eSpec ?? "").includes("comment") || String(auditRow.e2eSpec ?? "").includes("evidence"), `G005 matrix route ${path}: comment/evidence story`, `${auditPath}: ${path} e2eSpec must include comment or evidence lifecycle`);
      for (const field of ["sourceObject", "lifecycleStates", "denialScopeTest", "groupScopeStory"]) {
        assert(typeof auditRow[field] === "string" && auditRow[field].length >= 24, `G005 matrix route ${path}: ${field}`, `${auditPath}: ${path} missing ${field}`);
      }
      const combined = `${auditRow.ownerLane} ${auditRow.e2eSpec} ${auditRow.denialScopeTest} ${auditRow.groupScopeStory} ${matrixRow.requiredStory}`.toLowerCase();
      for (const needle of weakNeedles) {
        assert(!combined.includes(needle), `G005 matrix route ${path}: no weak ${needle} marker`, `${auditPath}: ${path} still contains weak marker ${needle}`);
      }
      assert(typeof auditRow.screenshotTraceEvidence === "string" && auditRow.screenshotTraceEvidence.includes("Pending"), `G005 matrix route ${path}: screenshot/trace is explicitly non-closed`, `${auditPath}: ${path} screenshotTraceEvidence must remain explicit until G009 live closure evidence lands`);
    }

    for (const depRoute of matrix.dependencyRoutes ?? []) {
      const auditRow = auditByPath.get(depRoute.path);
      assert(Boolean(auditRow), `G005 dependency route ${depRoute.path}: exists in route audit`, `${auditPath}: missing dependency routeCoverage for ${depRoute.path}`);
      if (!auditRow) continue;
      const combined = `${auditRow.ownerLane} ${auditRow.sourceObject} ${auditRow.e2eSpec} ${auditRow.groupScopeStory}`;
      assert(combined.includes(depRoute.expectedDependency), `G005 dependency route ${depRoute.path}: ${depRoute.expectedDependency}`, `${auditPath}: ${depRoute.path} must mention dependency ${depRoute.expectedDependency}`);
      assert(typeof depRoute.requiredStory === "string" && depRoute.requiredStory.length >= 48, `G005 dependency route ${depRoute.path}: required story`, `${matrixPath}: dependency route ${depRoute.path} requiredStory is too weak`);
    }
  }

  for (const contract of matrix.backendContracts ?? []) {
    requireFile(contract.file, `backend contract ${contract.file}`);
    assert(typeof contract.contract === "string" && contract.contract.length >= 40, `backend contract ${contract.file}: rationale`, `${matrixPath}: ${contract.file} contract rationale is too weak`);
    requireArrayOfStrings(contract.requiredSnippets, matrixPath, `backend contract ${contract.file} required snippets`);
    for (const snippet of contract.requiredSnippets ?? []) {
      requireIncludes(contract.file, snippet, `backend contract ${contract.file}: ${snippet}`);
    }
  }

  for (const contract of matrix.frontendContracts ?? []) {
    requireFile(contract.file, `frontend contract ${contract.file}`);
    assert(typeof contract.contract === "string" && contract.contract.length >= 40, `frontend contract ${contract.file}: rationale`, `${matrixPath}: ${contract.file} contract rationale is too weak`);
    requireArrayOfStrings(contract.requiredSnippets, matrixPath, `frontend contract ${contract.file} required snippets`);
    for (const snippet of contract.requiredSnippets ?? []) {
      requireIncludes(contract.file, snippet, `frontend contract ${contract.file}: ${snippet}`);
    }
  }

  for (const spec of matrix.requiredE2eSpecs ?? []) requireFile(spec, `G005 E2E spec ${spec}`);
  for (const test of matrix.requiredWebTests ?? []) requireFile(test, `G005 web test ${test}`);
  for (const test of matrix.requiredBackendTests ?? []) requireFile(test, `G005 backend test ${test}`);

  requireIncludes("e2e/specs/platform-maturity-g005-workflow-lifecycle.spec.ts", matrixPath, "G005 Playwright spec imports matrix");
  requireIncludes("e2e/specs/platform-maturity-g005-workflow-lifecycle.spec.ts", auditPath, "G005 Playwright spec imports route audit");
  requireIncludes("docs/specs/backlog-clearance-ledger.md", goalId, "backlog ledger records current G005 goal id");
  requireIncludes("docs/specs/foundation-gates.md", "workflow/approval/action lifecycle", "foundation gate mentions workflow/approval/action lifecycle");
  requireIncludes("docs/specs/foundation-gates.md", "Work Hub", "foundation gate mentions Work Hub server feed contract");

  const bannedCopyNeedles = ["Workflow + Approval", "업무 객체 중심 실행 흐름", "별도 데모", "coming soon", "Coming soon", "Lorem ipsum", "black background"];
  const sourceFilesWithUserVisibleWorkflow = [
    "web/src/pages/WorkflowStudioPage.tsx",
    "web/src/pages/WorkHubPage.tsx",
    "web/src/pages/ApprovalsPage.tsx",
    "web/src/features/approvals/ApprovalQueue.tsx",
    "web/src/pages/DailyPlanPage.tsx",
    "web/src/pages/WorkOrderDetailPage.tsx",
    "web/src/features/dispatch/WorkOrderDetail.tsx",
    "web/src/features/support/support-format.ts",
  ];
  for (const file of sourceFilesWithUserVisibleWorkflow) {
    for (const needle of bannedCopyNeedles) {
      requireNotIncludes(file, needle, `G005 no weak workflow copy in ${file}`);
    }
  }
}

if (failures.length) {
  console.error(`G005 workflow lifecycle gate failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}

console.log(`G005 workflow lifecycle gate passed (${passes.length} checks).`);
for (const item of passes) console.log(`- ${item}`);
