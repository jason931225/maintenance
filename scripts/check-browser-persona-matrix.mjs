#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const matrixPath = "docs/benchmarks/browser-persona-e2e-matrix.json";
const fixturePath = "e2e/fixtures/personas.ts";
const failures = [];
const passes = [];

function pathOf(path) {
  return resolve(root, path);
}

function read(path) {
  if (!existsSync(pathOf(path))) {
    failures.push(`${path}: missing`);
    return "";
  }
  return readFileSync(pathOf(path), "utf8");
}

function pass(label) {
  passes.push(label);
}

function assert(condition, passLabel, failureLabel) {
  if (condition) pass(passLabel);
  else failures.push(failureLabel);
}

function hasRequiredBrowserStory(value) {
  return /Required browser(?:\/mobile)? story/i.test(value ?? "");
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

const matrix = parseJson(matrixPath);
const fixture = read(fixturePath);
const packageJson = parseJson("package.json") ?? {};
const ci = read(".github/workflows/ci.yml");
const routeAudit = parseJson("docs/benchmarks/enterprise-ui-route-audit.json");

assert(packageJson.scripts?.["check:browser-persona-matrix"] === "node scripts/check-browser-persona-matrix.mjs", "package script check:browser-persona-matrix", "package.json must define check:browser-persona-matrix");
assert(ci.includes("npm run check:browser-persona-matrix"), "CI runs browser persona matrix gate", ".github/workflows/ci.yml must run npm run check:browser-persona-matrix");
assert(fixture.includes("browser-persona-e2e-matrix.json"), "persona fixture imports matrix JSON", `${fixturePath} must import browser-persona-e2e-matrix.json`);
assert(fixture.includes("LIVE_ORG_SLUGS"), "persona fixture exports live org slugs", `${fixturePath} must export LIVE_ORG_SLUGS`);
assert(fixture.includes("PERSONA_UI_STATES"), "persona fixture exports required UI states", `${fixturePath} must export PERSONA_UI_STATES`);

const requiredOrgSlugs = [
  "cheongun-hr",
  "cheongun-logis",
  "cnl",
  "coss",
  "dsl",
  "lso",
  "jy-tech",
  "knl",
];
const forbiddenLegacyOrgSlugs = ["elso"];
const requiredStates = ["loading", "empty", "error", "permission-denied"];
const requiredLadder = ["db", "api", "browser", "screenshot", "trace", "logs", "rollout"];
const requiredScopeModes = ["platform", "group-all", "org-selected", "own-dashboard", "denied-cross-scope"];

if (matrix) {
  assert(matrix.schemaVersion === 1, "matrix schema version 1", `${matrixPath}: schemaVersion must be 1`);
  assert(matrix.goalId === "G003-browser-e2e-persona-harness", "matrix owned by G003", `${matrixPath}: goalId must be G003-browser-e2e-persona-harness`);
  assert(matrix.fixtureModule === fixturePath, "matrix fixture module points to e2e fixture", `${matrixPath}: fixtureModule must be ${fixturePath}`);
  assert(Array.isArray(matrix.liveOrgSlugs), "matrix liveOrgSlugs array", `${matrixPath}: liveOrgSlugs must be an array`);
  for (const org of requiredOrgSlugs) {
    assert(matrix.liveOrgSlugs?.includes(org), `live org ${org}: covered`, `${matrixPath}: liveOrgSlugs must include ${org}`);
  }
  for (const org of forbiddenLegacyOrgSlugs) {
    assert(!matrix.liveOrgSlugs?.includes(org), `legacy org ${org}: absent`, `${matrixPath}: liveOrgSlugs must not include legacy slug ${org}`);
    assert(!fixture.includes(`"${org}"`), `legacy org ${org}: fixture absent`, `${fixturePath}: LIVE_ORG_SLUGS must not include legacy slug ${org}`);
  }
  assert(Array.isArray(matrix.personas), "matrix personas array", `${matrixPath}: personas must be an array`);
  const personas = matrix.personas ?? [];
  assert(personas.some((persona) => persona.personaId === "platform-admin" && persona.scopeModes?.includes("platform")), "platform-admin persona with platform scope", `${matrixPath}: missing platform-admin persona with platform scope`);
  assert(personas.some((persona) => persona.personaId === "group-admin" && persona.scopeModes?.includes("group-all")), "group-admin persona with group-all scope", `${matrixPath}: missing group-admin persona with group-all scope`);
  for (const org of requiredOrgSlugs) {
    assert(personas.some((persona) => persona.orgSlug === org), `persona for live org ${org}`, `${matrixPath}: missing persona for live org ${org}`);
  }
  for (const scopeMode of requiredScopeModes) {
    assert(personas.some((persona) => persona.scopeModes?.includes(scopeMode)), `scope mode ${scopeMode}: covered`, `${matrixPath}: no persona covers scope mode ${scopeMode}`);
  }
  const routeGroups = new Set();
  for (const persona of personas) {
    const label = persona.personaId ?? "<missing>";
    assert(typeof persona.personaId === "string" && persona.personaId.length >= 3, `persona ${label}: id`, `${matrixPath}: persona missing personaId`);
    assert(typeof persona.displayName === "string" && persona.displayName.length >= 2, `persona ${label}: displayName`, `${matrixPath}: ${label} missing displayName`);
    assert(typeof persona.orgSlug === "string" && persona.orgSlug.length >= 2, `persona ${label}: orgSlug`, `${matrixPath}: ${label} missing orgSlug`);
    assert(Array.isArray(persona.scopeModes) && persona.scopeModes.length > 0, `persona ${label}: scope modes`, `${matrixPath}: ${label} missing scopeModes`);
    assert(Array.isArray(persona.routeGroups) && persona.routeGroups.length > 0, `persona ${label}: route groups`, `${matrixPath}: ${label} missing routeGroups`);
    for (const routeGroup of persona.routeGroups ?? []) routeGroups.add(routeGroup);
    assert(Array.isArray(persona.e2eSpecs) && persona.e2eSpecs.length > 0, `persona ${label}: e2e specs`, `${matrixPath}: ${label} missing e2eSpecs`);
    for (const spec of persona.e2eSpecs ?? []) {
      assert(existsSync(pathOf(spec)), `persona ${label}: spec ${spec} exists`, `${matrixPath}: ${label} references missing spec ${spec}`);
    }
    assert(Array.isArray(persona.denialPaths) && persona.denialPaths.length > 0, `persona ${label}: denial paths`, `${matrixPath}: ${label} missing denialPaths`);
    for (const state of requiredStates) {
      assert(persona.uiStates?.includes(state), `persona ${label}: UI state ${state}`, `${matrixPath}: ${label} must cover UI state ${state}`);
    }
    assert(typeof persona.screenshotTraceEvidence === "string" && persona.screenshotTraceEvidence.includes("screenshot") && persona.screenshotTraceEvidence.includes("trace"), `persona ${label}: screenshot/trace evidence plan`, `${matrixPath}: ${label} missing screenshot/trace evidence plan`);
    for (const ladder of requiredLadder) {
      assert(persona.liveVerification?.includes(ladder), `persona ${label}: live verification ${ladder}`, `${matrixPath}: ${label} missing live verification step ${ladder}`);
    }
  }
  for (const group of ["identity", "platform", "group-org", "workflow", "assets", "collaboration", "import-export", "finance-reporting", "public-cx"]) {
    assert(routeGroups.has(group), `route group ${group}: covered by persona matrix`, `${matrixPath}: route group ${group} is not covered by any persona`);
  }
  if (routeAudit?.routeCoverage) {
    const personaIds = new Set(personas.map((persona) => persona.personaId));
    for (const row of routeAudit.routeCoverage) {
      assert(Array.isArray(row.personas) && row.personas.length > 0, `route ${row.rawPath}: route audit has personas`, `route audit ${row.rawPath}: missing personas`);
      assert(hasRequiredBrowserStory(row.e2eSpec), `route ${row.rawPath}: required browser story`, `route audit ${row.rawPath}: missing required browser story text`);
    }
    assert(personaIds.size === personas.length, "persona IDs are unique", `${matrixPath}: duplicate personaId values detected`);
  }
}

if (failures.length) {
  console.error(`Browser persona matrix check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}

console.log(`Browser persona matrix check passed (${passes.length} checks).`);
for (const item of passes) console.log(`- ${item}`);
