#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

function requireFile(path, label = path) {
  if (existsSync(pathOf(path))) {
    passes.push(`${label}: present`);
  } else {
    failures.push(`${label}: missing (${path})`);
  }
}

function requireIncludes(path, needle, label) {
  const text = read(path);
  if (text.includes(needle)) {
    passes.push(label);
  } else {
    failures.push(`${label}: ${path} must include ${JSON.stringify(needle)}`);
  }
}

function requireNotIncludes(path, needle, label) {
  const text = read(path);
  if (!text.includes(needle)) {
    passes.push(label);
  } else {
    failures.push(`${label}: ${path} must not include ${JSON.stringify(needle)}`);
  }
}

function requireScript(name) {
  const pkg = JSON.parse(read("package.json"));
  if (pkg.scripts?.[name]) {
    passes.push(`package script ${name}: ${pkg.scripts[name]}`);
  } else {
    failures.push(`package script ${name}: missing`);
  }
}

function assert(condition, ok, failure) {
  if (condition) {
    passes.push(ok);
  } else {
    failures.push(failure);
  }
}

function listSourceFiles(dir) {
  const files = [];
  const walk = (abs) => {
    for (const entry of readdirSync(abs)) {
      const child = join(abs, entry);
      const stat = statSync(child);
      if (stat.isDirectory()) {
        if (["node_modules", "dist", "coverage"].includes(entry)) continue;
        walk(child);
        continue;
      }
      const ext = extname(entry);
      if (![".ts", ".tsx"].includes(ext)) continue;
      if (/\.test\.[tj]sx?$/.test(entry) || /\.spec\.[tj]sx?$/.test(entry) || entry.endsWith(".d.ts")) {
        continue;
      }
      files.push(child);
    }
  };
  walk(pathOf(dir));
  return files;
}

const matrixPath = "docs/benchmarks/enterprise-parity-matrix.md";
const auditPath = "docs/benchmarks/enterprise-ui-route-audit.json";
requireFile(matrixPath, "enterprise parity matrix");
requireFile(auditPath, "enterprise UI route audit register");
requireScript("check:enterprise-ux-parity");
requireIncludes(".github/workflows/ci.yml", "npm run check:enterprise-ux-parity", "CI runs enterprise UX parity gate");
requireIncludes(".github/workflows/ci.yml", "docs/benchmarks/**", "CI watches benchmark/parity docs");

const matrix = read(matrixPath);
for (const needle of [
  "Pain point first",
  "Integrated workflow",
  "Group-wide by default",
  "Self-explanatory UI",
  "Story-aware",
  "Policy/audit/security aware",
  "No demo/stub paths",
  "Matrix traceability",
]) {
  assert(matrix.includes(needle), `matrix quality gate: ${needle}`, `${matrixPath}: missing quality gate ${needle}`);
}

const epIds = Array.from({ length: 17 }, (_, index) => `EP-${String(index + 1).padStart(3, "0")}`);
for (const ep of epIds) {
  assert(new RegExp(`^\\| ${ep} \\|`, "m").test(matrix), `${ep}: matrix table row`, `${matrixPath}: missing table row for ${ep}`);
  assert(new RegExp(`^### ${ep} \\u2014`, "m").test(matrix), `${ep}: matrix detail section`, `${matrixPath}: missing detail section for ${ep}`);
  const nextEp = `EP-${String(Number(ep.slice(3)) + 1).padStart(3, "0")}`;
  const start = matrix.indexOf(`### ${ep}`);
  const end = Number(ep.slice(3)) < 17 ? matrix.indexOf(`### ${nextEp}`, start + 1) : matrix.indexOf("## Priority backlog", start + 1);
  const section = matrix.slice(start, end > start ? end : undefined);
  for (const heading of [
    "Pain point",
    "Missing capabilities",
    "UX weaknesses",
    "Policy/audit/security gaps",
    "Data/model gaps",
    "Integration gaps",
    "E2E/user-story gaps",
  ]) {
    assert(section.includes(`**${heading}**`), `${ep}: ${heading}`, `${matrixPath}: ${ep} missing ${heading}`);
  }
}

const audit = JSON.parse(read(auditPath));
assert(audit.schemaVersion === 1, "route audit schema version 1", `${auditPath}: schemaVersion must be 1`);
assert(Array.isArray(audit.routeCoverage), "route audit routeCoverage array", `${auditPath}: routeCoverage must be an array`);
assert(Array.isArray(audit.epEvidence), "route audit epEvidence array", `${auditPath}: epEvidence must be an array`);
assert(Array.isArray(audit.trackedGaps), "route audit trackedGaps array", `${auditPath}: trackedGaps must be an array`);

const appRouter = read("web/src/AppRouter.tsx");
const routeMatches = [...appRouter.matchAll(/<Route[\s\S]*?path="([^"]+)"/g)]
  .map(([, path]) => path)
  .filter((path) => path !== "*");
const actualRoutes = new Set(routeMatches);
const duplicateRoutes = routeMatches.filter((route, index) => routeMatches.indexOf(route) !== index);
assert(duplicateRoutes.length === 0, `AppRouter route inventory: ${actualRoutes.size} unique routes`, `web/src/AppRouter.tsx: duplicate path strings ${duplicateRoutes.join(", ")}`);

const coveredRoutes = new Map();
for (const row of audit.routeCoverage) {
  const key = row.rawPath;
  if (coveredRoutes.has(key)) {
    failures.push(`${auditPath}: duplicate routeCoverage rawPath ${key}`);
    continue;
  }
  coveredRoutes.set(key, row);
  assert(typeof row.canonicalPath === "string" && row.canonicalPath.length > 0, `route ${key}: canonical path`, `${auditPath}: ${key} missing canonicalPath`);
  assert(Array.isArray(row.epRows) && row.epRows.length > 0, `route ${key}: EP coverage`, `${auditPath}: ${key} missing epRows`);
  for (const ep of row.epRows ?? []) {
    assert(epIds.includes(ep), `route ${key}: ${ep} exists`, `${auditPath}: ${key} references unknown ${ep}`);
  }
  assert(Array.isArray(row.personas) && row.personas.length > 0, `route ${key}: persona coverage`, `${auditPath}: ${key} missing personas`);
  assert(typeof row.roleStoryEvidence === "string" && row.roleStoryEvidence.length >= 16, `route ${key}: role-story evidence`, `${auditPath}: ${key} missing roleStoryEvidence`);
  assert(typeof row.accessibilityEvidence === "string" && row.accessibilityEvidence.length >= 16, `route ${key}: accessibility evidence`, `${auditPath}: ${key} missing accessibilityEvidence`);
}
for (const route of actualRoutes) {
  assert(coveredRoutes.has(route), `AppRouter route ${route}: covered`, `${auditPath}: missing routeCoverage for AppRouter route ${route}`);
}
for (const route of coveredRoutes.keys()) {
  assert(actualRoutes.has(route), `route audit ${route}: present in AppRouter`, `${auditPath}: routeCoverage ${route} is not present in AppRouter`);
}

const epEvidenceById = new Map(audit.epEvidence.map((row) => [row.id, row]));
for (const ep of epIds) {
  const row = epEvidenceById.get(ep);
  assert(Boolean(row), `${ep}: EP evidence row`, `${auditPath}: missing epEvidence for ${ep}`);
  if (row) {
    for (const key of ["ownerGoalId", "benchmarkTrace", "roleStoryEvidence", "accessibilityEvidence", "gapHandling"]) {
      assert(typeof row[key] === "string" && row[key].length >= 12, `${ep}: ${key}`, `${auditPath}: ${ep} missing ${key}`);
    }
  }
}
for (const gap of audit.trackedGaps) {
  assert(typeof gap.id === "string" && gap.id.length > 0, `tracked gap ${gap.id ?? "<missing>"}: id`, `${auditPath}: tracked gap missing id`);
  assert(Array.isArray(gap.epRows) && gap.epRows.every((ep) => epIds.includes(ep)), `tracked gap ${gap.id}: EP rows`, `${auditPath}: tracked gap ${gap.id} has invalid epRows`);
  assert(typeof gap.ownerGoalId === "string" && gap.ownerGoalId.startsWith("G"), `tracked gap ${gap.id}: owner goal`, `${auditPath}: tracked gap ${gap.id} missing ownerGoalId`);
  assert(typeof gap.rule === "string" && gap.rule.length >= 24, `tracked gap ${gap.id}: rule`, `${auditPath}: tracked gap ${gap.id} missing rule`);
}

// Specific user-reported text-wall regression: these strings are allowed in
// docs/tests that preserve the historical bug, but never in production UI.
const bannedNeedles = [
  "Workflow + Approval",
  "업무 객체 중심 실행 흐름",
  "허브는 메신저·메일·티켓을 별도 데모로 분리하지 않고",
  "권한·감사 기반",
  "별도 데모",
  "데모로 분리",
  "백엔드에서 아직 제공되지 않습니다",
  "excel_export_logs 미노출",
  "준비 후 허용",
  "Lorem ipsum",
  "coming soon",
  "Coming soon",
];
for (const file of listSourceFiles("web/src")) {
  const rel = file.slice(root.length + 1);
  const text = readFileSync(file, "utf8");
  for (const needle of bannedNeedles) {
    if (text.includes(needle)) {
      failures.push(`${rel}: production UI must not include banned/dead copy ${JSON.stringify(needle)}`);
    }
  }
}
if (!failures.some((failure) => failure.includes("production UI must not include banned/dead copy"))) {
  passes.push(`production UI banned-copy scan: ${bannedNeedles.length} needles across web/src`);
}

requireNotIncludes("web/src/pages/WorkHubPage.tsx", "업무 객체 중심 실행 흐름", "Work Hub removed reported text-wall heading");
requireIncludes("web/src/pages/WorkHubPage.test.tsx", "not.toBeInTheDocument", "Work Hub regression test asserts text-wall absence");
requireIncludes("web/src/pages/WorkHubPage.test.tsx", "actionable group-wide priority inbox without explanatory text walls", "Work Hub test asserts actionable queue pattern");
requireNotIncludes("web/src/features/reporting/ReportingExport.tsx", "historyNote", "Reporting export has no backend-missing history note");
requireIncludes("web/src/pages/ReportingPage.test.tsx", "백엔드에서 아직 제공되지", "Reporting test preserves dead-copy regression guard");
requireIncludes("docs/benchmarks/enterprise-ui-route-audit.json", "G023-enterprise-ui-parity-audit-and-no-te", "route audit owned by G023");

if (failures.length) {
  console.error("Enterprise UX parity check failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`Enterprise UX parity check passed (${passes.length} checks).`);
for (const pass of passes) {
  console.log(`- ${pass}`);
}
