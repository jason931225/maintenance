#!/usr/bin/env node
/** Prospective, deterministic clean-architecture boundary gate. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, lstatSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";

const SOURCE_EXTENSIONS = new Set([".rs", ".ts", ".tsx"]);
const FORBIDDEN_INNER_DEPS = new Set(["axum", "sqlx", "http", "reqwest", "hyper", "leptos", "yew", "dioxus"]);
const FRONTEND_LAYERS = new Map([["domain", 0], ["application", 1], ["adapters", 2], ["ui", 3]]);

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
function normal(path) { return normalize(path).replaceAll("\\", "/"); }
function violation(rule, path, detail) { return { rule, path: normal(path), detail }; }
function componentLayer(path, root) {
  const match = normal(relative(join(root, "backend/crates"), path)).match(/^([^/]+)\/(domain|application|adapter-[^/]+|rest)\//);
  return match ? { component: match[1], layer: match[2].startsWith("adapter-") ? "adapter" : match[2] } : null;
}
function cargoDependencies(text, workspaceDependencies = new Map()) {
  let inDependencies = false;
  const dependencies = [];
  let pending = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = `${pending}${rawLine}`;
    if (pending && /}/.test(rawLine)) pending = "";
    else if (!pending && /{[^}]*$/.test(rawLine)) { pending = `${rawLine} `; continue; }
    if (/^\[(?:workspace\.)?(?:target\..+\.)?(?:dev-)?dependencies\]$/.test(line)) { inDependencies = true; continue; }
    if (/^\[/.test(line)) { inDependencies = false; continue; }
    if (!inDependencies) continue;
    const match = line.match(/^([\w-]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const alias = match[1];
    dependencies.push({ alias, package: match[2].match(/package\s*=\s*"([^"]+)"/)?.[1] ?? (match[2].includes("workspace = true") ? workspaceDependencies.get(alias) ?? alias : alias) });
  }
  return dependencies;
}
function resolveImport(source, specifier, web) {
  const base = specifier.startsWith("@/") ? join(web, specifier.slice(2)) : specifier.startsWith(".") ? resolve(dirname(source), specifier) : null;
  if (!base) return null;
  return [base, ...[".ts", ".tsx", ".js", "/index.ts", "/public.ts"].map((suffix) => `${base}${suffix}`)].find(existsSync) ?? null;
}
function importsIn(text) { return [...text.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g)].map((match) => match[1]); }
function featurePath(path) { return normal(path).match(/^features\/([^/]+)(?:\/|$)/)?.[1] ?? null; }
function manifestForSource(source) {
  let directory = dirname(source);
  while (dirname(directory) !== directory) {
    const manifest = join(directory, "Cargo.toml");
    if (existsSync(manifest)) return manifest;
    directory = dirname(directory);
  }
  return join(dirname(dirname(source)), "Cargo.toml");
}
function isGeneratedApiExport(text) {
  // Conservative provenance: any generated import which is also exported (as a
  // type, value, namespace, interface base, or barrel) is a transport leak.
  if (/export[\s\S]*?from\s+["']@maintenance\/api-client-ts["']/.test(text)) return true;
  const aliases = [...text.matchAll(/import(?:\s+type)?\s+(?:\*\s+as\s+([\w$]+)|\{([^}]+)\}|([\w$]+))\s+from\s+["']@maintenance\/api-client-ts["']/g)]
    .flatMap((match) => [match[1], match[3], ...(match[2] ?? "").split(",").map((part) => part.trim().split(/\s+as\s+/).at(-1))].filter(Boolean));
  // A module at a public transport boundary may not export anything after
  // importing generated provenance: local aliases/chains are deliberately
  // treated as tainted until mapped in a non-exporting adapter implementation.
  return aliases.length > 0 && /\bexport\b/.test(text);
}
function moduleForPath(path) {
  const normalized = normal(path);
  return normalized.match(/^backend\/crates\/([^/]+)\//)?.[1]
    ?? normalized.match(/^web\/src\/features\/([^/]+)\//)?.[1]
    ?? normalized.match(/^web\/src\/console\/([^/]+)\//)?.[1]
    ?? (normalized.startsWith("web/src/pages/") ? "pages" : "platform");
}

export function collectViolations(root, changedPaths = []) {
  const absoluteRoot = resolve(root);
  const changed = new Set(changedPaths.map((path) => normal(isAbsolute(path) ? path : resolve(absoluteRoot, path))));
  const selected = (path) => changed.size === 0 || changed.has(normal(path));
  const violations = [];
  for (const path of changed) {
    try {
      const real = normal(realpathSync(path));
      if (lstatSync(path).isSymbolicLink() || !real.startsWith(`${normal(realpathSync(absoluteRoot))}/`)) violations.push(violation("path-canonical-containment", path, "symlink-or-outside-root"));
    } catch { violations.push(violation("path-canonical-containment", path, "unresolvable-path")); }
  }
  const backend = join(absoluteRoot, "backend/crates");
  const workspaceManifest = join(absoluteRoot, "backend/Cargo.toml");
  const workspaceDependencies = new Map((existsSync(workspaceManifest) ? cargoDependencies(readFileSync(workspaceManifest, "utf8")) : []).map((dependency) => [dependency.alias, dependency.package]));
  const dependencyCache = new Map();
  const dependenciesFor = (manifest) => {
    if (!dependencyCache.has(manifest)) dependencyCache.set(manifest, existsSync(manifest) ? cargoDependencies(readFileSync(manifest, "utf8"), workspaceDependencies) : []);
    return dependencyCache.get(manifest);
  };

  for (const manifest of walk(backend).filter((path) => basename(path) === "Cargo.toml" && selected(path))) {
    const layer = componentLayer(manifest, absoluteRoot);
    if (!layer) continue;
    for (const dependency of dependenciesFor(manifest)) {
      const target = dependency.package.match(/^mnt-([a-z0-9-]+)-(domain|application|adapter-[a-z0-9-]+|rest)$/)?.[2];
      const permitted = { domain: ["domain"], application: ["domain"], adapter: ["domain", "application"], rest: ["application"] };
      if (target && !permitted[layer.layer].includes(target.startsWith("adapter-") ? "adapter" : target)) {
        violations.push(violation("backend-dependency-direction", manifest, `${layer.layer}->${dependency.package}`));
      }
      if (["domain", "application"].includes(layer.layer) && FORBIDDEN_INNER_DEPS.has(dependency.package)) {
        violations.push(violation("backend-inner-framework", manifest, `${layer.layer}->${dependency.package}`));
      }
    }
  }

  for (const source of walk(backend).filter((path) => extname(path) === ".rs" && selected(path))) {
    const layer = componentLayer(source, absoluteRoot);
    if (!layer) continue;
    const text = readFileSync(source, "utf8");
    const aliases = dependenciesFor(manifestForSource(source)).filter((dependency) => FORBIDDEN_INNER_DEPS.has(dependency.package)).map((dependency) => dependency.alias.replaceAll("-", "_"));
    if (["domain", "application"].includes(layer.layer) && aliases.some((alias) => new RegExp(`\\b${alias}::`).test(text))) {
      violations.push(violation("backend-inner-framework", source, "framework-import"));
    }
    // REST is transport-only: it delegates to application DTOs/use cases, never
    // persistence nor a component's domain lifecycle model.
    if (layer.layer === "rest" && (new RegExp(`\\bmnt_${layer.component.replaceAll("-", "_")}_domain::`).test(text) || /\b(?:sqlx|diesel|sea_orm)::|\.(?:execute|fetch_one|fetch_all|fetch_optional)\s*\(|\b(?:INSERT|UPDATE|DELETE)\s+INTO\b/.test(text))) {
      violations.push(violation("rest-application-boundary", source, "direct-persistence-or-domain-model"));
    }
  }

  const web = join(absoluteRoot, "web/src");
  const generatedExportModules = new Set(walk(web).filter((path) => {
    const sourceRelative = normal(relative(web, path));
    return SOURCE_EXTENSIONS.has(extname(path)) && (/^api\//.test(sourceRelative) || /^features\/[^/]+\/(?:adapters|public|index)\//.test(sourceRelative) || /^features\/[^/]+\/(?:public|index)\.(?:ts|tsx)$/.test(sourceRelative)) && isGeneratedApiExport(readFileSync(path, "utf8"));
  }).map((path) => normal(path)));
  for (const source of walk(web).filter((path) => SOURCE_EXTENSIONS.has(extname(path)) && selected(path))) {
    const text = readFileSync(source, "utf8");
    const sourceRelative = normal(relative(web, source));
    const sourceFeature = featurePath(sourceRelative);
    const structured = sourceRelative.match(/^features\/[^/]+\/(domain|application|adapters|ui)\//)?.[1];
    for (const specifier of importsIn(text)) {
      if (specifier === "@maintenance/api-client-ts" && !(/^api\//.test(sourceRelative) || /^console\/[^/]+\/[^/]*[Aa]pi\.tsx?$/.test(sourceRelative) || /^features\/[^/]+\/adapters\//.test(sourceRelative))) {
        violations.push(violation("generated-client-boundary", source, specifier));
      }
      const target = resolveImport(source, specifier, web);
      if (!target) continue;
      const canonicalWeb = normal(realpathSync(web));
      let canonicalTarget;
      try { canonicalTarget = normal(realpathSync(target)); } catch { canonicalTarget = ""; }
      if (!canonicalTarget.startsWith(`${canonicalWeb}/`)) {
        violations.push(violation("frontend-import-containment", source, specifier));
        continue;
      }
      const targetRelative = normal(relative(web, target));
      const targetFeature = featurePath(targetRelative);
      const targetLayer = targetRelative.match(/^features\/[^/]+\/(domain|application|adapters|ui)\//)?.[1];
      if (structured && targetFeature === sourceFeature && targetLayer && FRONTEND_LAYERS.get(targetLayer) > FRONTEND_LAYERS.get(structured)) {
        violations.push(violation("frontend-dependency-direction", source, `${structured}->${targetLayer}`));
      }
      if (targetFeature && sourceFeature !== targetFeature && !/\/features\/[^/]+\/(?:public|index)\.(?:ts|tsx)$/.test(targetRelative)) {
        violations.push(violation("module-public-surface", source, `${sourceFeature}->${targetFeature}`));
      }
      if (generatedExportModules.has(normal(target)) && !(/^api\//.test(sourceRelative) || /^console\/[^/]+\/[^/]*[Aa]pi\.tsx?$/.test(sourceRelative) || /^features\/[^/]+\/adapters\//.test(sourceRelative))) {
        violations.push(violation("generated-client-reexport-boundary", source, targetRelative));
      }
    }
  }
  for (const path of changed.size ? changed : walk(web)) {
    if (/^(?:shared\/|components\/shared\/)/.test(normal(relative(web, path)))) violations.push(violation("no-global-shared-dumping-ground", path, "use-ui-or-console-capability"));
  }
  return [...new Map(violations.map((item) => {
    const path = normal(relative(absoluteRoot, item.path));
    const normalized = { ...item, path, id: `${item.rule}:${path}:${item.detail}` };
    return [normalized.id, normalized];
  })).values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function evaluateLedgerGrowth(ledger, trustedLedger) {
  const trusted = new Map((trustedLedger.exceptions ?? []).map((entry) => [entry.id, JSON.stringify(entry)]));
  return (ledger.exceptions ?? []).flatMap((entry) => {
    const prior = trusted.get(entry.id);
    if (!prior) return [{ rule: "exception-ledger-growth", path: "scripts/architecture/exception-ledger.json", detail: `unapproved:${entry.id}`, id: `exception-ledger-growth:${entry.id}` }];
    return prior === JSON.stringify(entry) ? [] : [{ rule: "exception-ledger-growth", path: "scripts/architecture/exception-ledger.json", detail: `modified:${entry.id}`, id: `exception-ledger-growth:${entry.id}` }];
  });
}
export function validateLedger(ledger, today = new Date().toISOString().slice(0, 10)) {
  const ids = new Set();
  return (ledger.exceptions ?? []).flatMap((entry) => {
    const issues = [];
    if (!entry.id || ids.has(entry.id)) issues.push("duplicate-or-missing-id");
    ids.add(entry.id);
    if (!entry.owner?.trim()) issues.push("missing-owner");
    if (!/^[a-z0-9-]+$/.test(entry.module ?? "")) issues.push("invalid-module");
    if (entry.module !== moduleForPath(entry.path ?? "")) issues.push("path-module-mismatch");
    if (!/^team-[a-z0-9-]+$/.test(entry.owner ?? "")) issues.push("invalid-owner");
    if (!/^[A-Z]+-\d{4}-Q[1-4]$/.test(entry.milestone ?? "") || entry.target !== `${entry.milestone}/${entry.module}`) issues.push("invalid-target-or-milestone");
    const horizon = new Date(`${today}T00:00:00Z`); horizon.setUTCDate(horizon.getUTCDate() + 90);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expiresOn ?? "") || entry.expiresOn < today || entry.expiresOn > horizon.toISOString().slice(0, 10)) issues.push("stale-or-excessive-expiry");
    return issues.map((detail) => ({ rule: "exception-ledger-validity", path: "scripts/architecture/exception-ledger.json", detail: `${detail}:${entry.id}`, id: `exception-ledger-validity:${detail}:${entry.id}` }));
  });
}
export function validateCiBaseline(root, suppliedSha) {
  const fail = (detail) => [{ rule: "ci-baseline-contract", path: "scripts/architecture/ci-baseline-contract.json", detail, id: `ci-baseline-contract:${detail}` }];
  if (!/^[0-9a-f]{40}$/.test(suppliedSha ?? "")) return fail("baseline-must-be-full-immutable-sha");
  try {
    if (execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() === suppliedSha) return fail("candidate-head-cannot-be-trusted-authority");
    if (execFileSync("git", ["-C", root, "rev-parse", `${suppliedSha}^{commit}`], { encoding: "utf8" }).trim() !== suppliedSha) return fail("baseline-identity-mismatch");
    execFileSync("git", ["-C", root, "merge-base", "--is-ancestor", suppliedSha, "HEAD"]);
    return [];
  } catch { return fail("baseline-is-not-an-ancestor-of-head"); }
}
function trustedFile(root, commit, path) {
  return JSON.parse(execFileSync("git", ["-C", root, "show", `${commit}:${path}`], { encoding: "utf8" }));
}
export function evaluateArchitecture(root, changedPaths = [], debt = [], ledgerFailures = []) {
  const known = new Set(debt.map((entry) => typeof entry === "string" ? entry : entry.id));
  const violations = collectViolations(root, changedPaths);
  return { violations, failures: [...ledgerFailures, ...violations.filter((item) => !known.has(item.id))], debt: violations.filter((item) => known.has(item.id)) };
}
function parseArgs(args) {
  const result = { root: process.cwd(), changedPaths: [], format: "json", ciBaselineSha: null };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--root") result.root = args[++index];
    else if (args[index] === "--changed-path") result.changedPaths.push(args[++index]);
    else if (args[index] === "--changed-paths-file") result.changedPaths.push(...readFileSync(args[++index], "utf8").split(/\r?\n/).filter(Boolean));
    else if (args[index] === "--protected-base-sha") result.ciBaselineSha = args[++index];
    else if (args[index] === "--format") result.format = args[++index];
    else throw new Error(`unknown argument: ${args[index]}`);
  }
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const options = parseArgs(process.argv.slice(2));
  const ledgerPath = join(resolve(options.root), "scripts/architecture/exception-ledger.json");
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const baselineFailures = validateCiBaseline(resolve(options.root), options.ciBaselineSha);
  let growthFailures = [];
  let trustedLedger = { exceptions: [] };
  try {
    const contract = trustedFile(resolve(options.root), options.ciBaselineSha, "scripts/architecture/ci-baseline-contract.json");
    if (contract.schemaVersion < 3 || contract.ledgerPath !== "scripts/architecture/exception-ledger.json") throw new Error("invalid trusted contract");
    trustedLedger = trustedFile(resolve(options.root), options.ciBaselineSha, contract.ledgerPath);
    growthFailures = evaluateLedgerGrowth(ledger, trustedLedger);
  } catch { growthFailures = [{ rule: "exception-ledger-trust", path: "scripts/architecture/exception-ledger.json", detail: "unreadable-protected-base-contract-or-ledger", id: "exception-ledger-trust:unreadable-protected-base-contract-or-ledger" }]; }
  const ledgerFailures = validateLedger(ledger);
  // Candidate ledger is a migration proposal only. Known debt comes exclusively
  // from the immutable protected-parent ledger.
  const result = evaluateArchitecture(options.root, options.changedPaths, trustedLedger.exceptions ?? [], [...baselineFailures, ...growthFailures, ...ledgerFailures]);
  process.stdout.write(`${JSON.stringify({ mode: options.changedPaths.length ? "changed-paths" : "full", ciBaselineSha: options.ciBaselineSha, ...result }, null, 2)}\n`);
  process.exitCode = result.failures.length ? 1 : 0;
}
