#!/usr/bin/env node
/** Prospective, deterministic clean-architecture boundary gate. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
function cargoDependencies(text) {
  let inDependencies = false;
  const dependencies = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\[(?:dev-)?dependencies\]$/.test(line)) { inDependencies = true; continue; }
    if (/^\[/.test(line)) { inDependencies = false; continue; }
    if (!inDependencies) continue;
    const match = line.match(/^([\w-]+)\s*=\s*(.*)$/);
    if (!match) continue;
    dependencies.push({ alias: match[1], package: match[2].match(/package\s*=\s*"([^"]+)"/)?.[1] ?? match[1] });
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
function manifestForSource(source) { return join(dirname(dirname(source)), "Cargo.toml"); }
function isGeneratedApiExport(text) {
  return /export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+["']@maintenance\/api-client-ts["']/.test(text)
    || /export\s+type\s+\w+\s*=\s*(?:components|operations|paths)\b/.test(text);
}

export function collectViolations(root, changedPaths = []) {
  const absoluteRoot = resolve(root);
  const changed = new Set(changedPaths.map((path) => normal(isAbsolute(path) ? path : resolve(absoluteRoot, path))));
  const selected = (path) => changed.size === 0 || changed.has(normal(path));
  const violations = [];
  const backend = join(absoluteRoot, "backend/crates");
  const dependencyCache = new Map();
  const dependenciesFor = (manifest) => {
    if (!dependencyCache.has(manifest)) dependencyCache.set(manifest, existsSync(manifest) ? cargoDependencies(readFileSync(manifest, "utf8")) : []);
    return dependencyCache.get(manifest);
  };

  for (const manifest of walk(backend).filter((path) => basename(path) === "Cargo.toml" && selected(path))) {
    const layer = componentLayer(manifest, absoluteRoot);
    if (!layer) continue;
    for (const dependency of dependenciesFor(manifest)) {
      const ownPrefix = `mnt-${layer.component}-`;
      const target = dependency.package.startsWith(ownPrefix) ? dependency.package.slice(ownPrefix.length) : null;
      if (target && ((layer.layer === "domain" && target !== "domain") || (layer.layer === "application" && ["adapter-postgres", "rest"].includes(target)) || (layer.layer === "adapter" && target === "rest"))) {
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
    // REST is transport-only: no direct persistence/mutation in handlers or helpers.
    if (layer.layer === "rest" && /\b(?:sqlx|diesel|sea_orm)::|\.(?:execute|fetch_one|fetch_all|fetch_optional)\s*\(|\b(?:INSERT|UPDATE|DELETE)\s+INTO\b|\b\w+\.(?:status|state|lifecycle_state)\s*=/.test(text)) {
      violations.push(violation("rest-delegation-boundary", source, "direct-persistence-or-lifecycle-mutation"));
    }
  }

  const web = join(absoluteRoot, "web/src");
  const generatedExportModules = new Set(walk(join(web, "api")).filter((path) => SOURCE_EXTENSIONS.has(extname(path)) && isGeneratedApiExport(readFileSync(path, "utf8"))).map((path) => normal(path)));
  for (const source of walk(web).filter((path) => SOURCE_EXTENSIONS.has(extname(path)) && selected(path))) {
    const text = readFileSync(source, "utf8");
    const sourceRelative = normal(relative(web, source));
    const sourceFeature = featurePath(sourceRelative);
    const structured = sourceRelative.match(/^features\/[^/]+\/(domain|application|adapters|ui)\//)?.[1];
    for (const specifier of importsIn(text)) {
      if (specifier === "@maintenance/api-client-ts" && !(/^api\//.test(sourceRelative) || /^features\/[^/]+\/adapters\//.test(sourceRelative))) {
        violations.push(violation("generated-client-boundary", source, specifier));
      }
      const target = resolveImport(source, specifier, web);
      if (!target) continue;
      const targetRelative = normal(relative(web, target));
      const targetFeature = featurePath(targetRelative);
      const targetLayer = targetRelative.match(/^features\/[^/]+\/(domain|application|adapters|ui)\//)?.[1];
      if (structured && targetFeature === sourceFeature && targetLayer && FRONTEND_LAYERS.get(targetLayer) > FRONTEND_LAYERS.get(structured)) {
        violations.push(violation("frontend-dependency-direction", source, `${structured}->${targetLayer}`));
      }
      if (sourceFeature && targetFeature && sourceFeature !== targetFeature && !/\/features\/[^/]+\/(?:public|index)\.(?:ts|tsx)$/.test(targetRelative)) {
        violations.push(violation("module-public-surface", source, `${sourceFeature}->${targetFeature}`));
      }
      if (generatedExportModules.has(normal(target)) && !(/^api\//.test(sourceRelative) || /^features\/[^/]+\/adapters\//.test(sourceRelative))) {
        violations.push(violation("generated-client-reexport-boundary", source, targetRelative));
      }
    }
  }
  for (const path of changed.size ? changed : walk(web)) {
    if (/^(?:shared\/|components\/shared\/)/.test(normal(relative(web, path)))) violations.push(violation("no-global-shared-dumping-ground", path, "use-ui-or-console-capability"));
  }
  return violations.map((item) => {
    const path = normal(relative(absoluteRoot, item.path));
    return { ...item, path, id: `${item.rule}:${path}:${item.detail}` };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export function evaluateLedgerGrowth(ledger, trustedLedger) {
  const trusted = new Map((trustedLedger.exceptions ?? []).map((entry) => [entry.id, JSON.stringify(entry)]));
  return (ledger.exceptions ?? []).flatMap((entry) => {
    const prior = trusted.get(entry.id);
    if (!prior) return [{ rule: "exception-ledger-growth", path: "scripts/architecture/exception-ledger.json", detail: `unapproved:${entry.id}`, id: `exception-ledger-growth:${entry.id}` }];
    return prior === JSON.stringify(entry) ? [] : [{ rule: "exception-ledger-growth", path: "scripts/architecture/exception-ledger.json", detail: `modified:${entry.id}`, id: `exception-ledger-growth:${entry.id}` }];
  });
}
export function evaluateArchitecture(root, changedPaths = [], debt = [], ledgerFailures = []) {
  const known = new Set(debt.map((entry) => typeof entry === "string" ? entry : entry.id));
  const violations = collectViolations(root, changedPaths);
  return { violations, failures: [...ledgerFailures, ...violations.filter((item) => !known.has(item.id))], debt: violations.filter((item) => known.has(item.id)) };
}
function parseArgs(args) {
  const result = { root: process.cwd(), changedPaths: [], format: "json", trustedBaseRef: null };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--root") result.root = args[++index];
    else if (args[index] === "--changed-path") result.changedPaths.push(args[++index]);
    else if (args[index] === "--changed-paths-file") result.changedPaths.push(...readFileSync(args[++index], "utf8").split(/\r?\n/).filter(Boolean));
    else if (args[index] === "--trusted-base-ref") result.trustedBaseRef = args[++index];
    else if (args[index] === "--format") result.format = args[++index];
    else throw new Error(`unknown argument: ${args[index]}`);
  }
  return result;
}
function trustedLedger(root, ref) {
  return JSON.parse(execFileSync("git", ["-C", root, "show", `${ref}:scripts/architecture/exception-ledger.json`], { encoding: "utf8" }));
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const options = parseArgs(process.argv.slice(2));
  const ledgerPath = join(resolve(options.root), "scripts/architecture/exception-ledger.json");
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const baseRef = options.trustedBaseRef ?? ledger.trustedBaseRef;
  const ledgerFailures = baseRef ? evaluateLedgerGrowth(ledger, trustedLedger(resolve(options.root), baseRef)) : [{ rule: "exception-ledger-trust", path: "scripts/architecture/exception-ledger.json", detail: "missing-trusted-base-ref", id: "exception-ledger-trust:missing-trusted-base-ref" }];
  const result = evaluateArchitecture(options.root, options.changedPaths, ledger.exceptions ?? [], ledgerFailures);
  process.stdout.write(`${JSON.stringify({ mode: options.changedPaths.length ? "changed-paths" : "full", trustedBaseRef: baseRef, ...result }, null, 2)}\n`);
  process.exitCode = result.failures.length ? 1 : 0;
}
