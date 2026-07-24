#!/usr/bin/env node
/**
 * Prospective clean-architecture boundary gate. It intentionally checks only
 * conventionally layered components; it never requires a module to create
 * empty directories merely to satisfy the gate.
 */
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
function violation(rule, path, detail) {
  const source = normal(path);
  return { id: `${rule}:${source}:${detail}`, rule, path: source, detail };
}

function componentLayer(path, root) {
  const match = normal(relative(join(root, "backend/crates"), path)).match(/^([^/]+)\/(domain|application|adapter-[^/]+|rest)\//);
  if (!match) return null;
  return { component: match[1], layer: match[2].startsWith("adapter-") ? "adapter" : match[2] };
}

function cargoDependencyNames(text) {
  let inDependencies = false;
  const names = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\[(?:dev-)?dependencies\]$/.test(line)) { inDependencies = true; continue; }
    if (/^\[/.test(line)) { inDependencies = false; continue; }
    if (inDependencies) {
      const match = line.match(/^([\w-]+)\s*=/);
      if (match) names.push(match[1]);
    }
  }
  return names;
}

function resolveImport(source, specifier) {
  if (!specifier.startsWith(".")) return null;
  const candidates = [resolve(dirname(source), specifier), ...[".ts", ".tsx", ".js", "/index.ts", "/public.ts"].map((suffix) => resolve(dirname(source), `${specifier}${suffix}`))];
  return candidates.find(existsSync) ?? null;
}

function importsIn(text) {
  return [...text.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g)].map((match) => match[1]);
}

export function collectViolations(root, changedPaths = []) {
  const absoluteRoot = resolve(root);
  const changed = new Set(changedPaths.map((path) => normal(isAbsolute(path) ? path : resolve(absoluteRoot, path))));
  const selected = (path) => changed.size === 0 || changed.has(normal(path));
  const violations = [];
  const backend = join(absoluteRoot, "backend/crates");

  for (const manifest of walk(backend).filter((path) => basename(path) === "Cargo.toml")) {
    const layer = componentLayer(manifest, absoluteRoot);
    if (!layer || !selected(manifest)) continue;
    const dependencies = cargoDependencyNames(readFileSync(manifest, "utf8"));
    for (const dependency of dependencies) {
      const ownPrefix = `mnt-${layer.component}-`;
      const target = dependency.startsWith(ownPrefix) ? dependency.slice(ownPrefix.length) : null;
      if (target && ((layer.layer === "domain" && target !== "domain") || (layer.layer === "application" && ["adapter-postgres", "rest"].includes(target)) || (layer.layer === "adapter" && target === "rest"))) {
        violations.push(violation("backend-dependency-direction", manifest, `${layer.layer}->${dependency}`));
      }
      if (["domain", "application"].includes(layer.layer) && FORBIDDEN_INNER_DEPS.has(dependency)) {
        violations.push(violation("backend-inner-framework", manifest, `${layer.layer}->${dependency}`));
      }
    }
  }

  for (const source of walk(backend).filter((path) => extname(path) === ".rs" && selected(path))) {
    const layer = componentLayer(source, absoluteRoot);
    if (!layer) continue;
    const text = readFileSync(source, "utf8");
    if (["domain", "application"].includes(layer.layer) && /\b(?:axum|sqlx|http|reqwest|hyper|leptos|yew|dioxus)::/.test(text)) {
      violations.push(violation("backend-inner-framework", source, "framework-import"));
    }
    if (layer.layer === "rest" && /\b(?:pub\s+)?(?:async\s+)?fn\s+(?:transition|approve|reject|cancel|complete|close|reopen)_[a-z_]+/.test(text)) {
      violations.push(violation("rest-lifecycle-policy", source, "lifecycle-named-handler"));
    }
  }

  const web = join(absoluteRoot, "web/src");
  for (const source of walk(web).filter((path) => SOURCE_EXTENSIONS.has(extname(path)) && selected(path))) {
    const text = readFileSync(source, "utf8");
    const sourceRelative = normal(relative(web, source));
    const structured = sourceRelative.match(/^features\/([^/]+)\/(domain|application|adapters|ui)\//);
    for (const specifier of importsIn(text)) {
      if (specifier === "@maintenance/api-client-ts" && !(/^api\//.test(sourceRelative) || /^features\/[^/]+\/adapters\//.test(sourceRelative))) {
        violations.push(violation("generated-client-boundary", source, specifier));
      }
      const target = resolveImport(source, specifier);
      if (!target) continue;
      const targetRelative = normal(relative(web, target));
      const targetStructured = targetRelative.match(/^features\/([^/]+)\/(domain|application|adapters|ui)\//);
      if (structured && targetStructured && structured[1] === targetStructured[1] && FRONTEND_LAYERS.get(targetStructured[2]) > FRONTEND_LAYERS.get(structured[2])) {
        violations.push(violation("frontend-dependency-direction", source, `${structured[2]}->${targetStructured[2]}`));
      }
      if (structured && targetStructured && structured[1] !== targetStructured[1] && !/\/(?:public|index)\.(?:ts|tsx)$/.test(targetRelative)) {
        violations.push(violation("module-public-surface", source, `${structured[1]}->${targetStructured[1]}`));
      }
    }
  }

  for (const path of changed.size ? changed : walk(web)) {
    const relativePath = normal(relative(web, path));
    if (/^(?:shared\/|components\/shared\/)/.test(relativePath)) {
      violations.push(violation("no-global-shared-dumping-ground", path, "use-ui-or-console-capability"));
    }
  }
  return violations
    .map((item) => {
      const path = normal(relative(absoluteRoot, item.path));
      return { ...item, path, id: `${item.rule}:${path}:${item.detail}` };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function evaluateArchitecture(root, changedPaths = [], debt = []) {
  const known = new Set(debt.map((entry) => typeof entry === "string" ? entry : entry.id));
  const violations = collectViolations(root, changedPaths);
  return { violations, failures: violations.filter((item) => !known.has(item.id)), debt: violations.filter((item) => known.has(item.id)) };
}

function parseArgs(args) {
  const result = { root: process.cwd(), changedPaths: [], format: "json" };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--root") result.root = args[++index];
    else if (args[index] === "--changed-path") result.changedPaths.push(args[++index]);
    else if (args[index] === "--changed-paths-file") result.changedPaths.push(...readFileSync(args[++index], "utf8").split(/\r?\n/).filter(Boolean));
    else if (args[index] === "--format") result.format = args[++index];
    else throw new Error(`unknown argument: ${args[index]}`);
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const options = parseArgs(process.argv.slice(2));
  const ledgerPath = join(resolve(options.root), "scripts/architecture/exception-ledger.json");
  const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")).exceptions ?? [] : [];
  const result = evaluateArchitecture(options.root, options.changedPaths, ledger);
  process.stdout.write(`${JSON.stringify({ mode: options.changedPaths.length ? "changed-paths" : "full", ...result }, null, 2)}\n`);
  process.exitCode = result.failures.length ? 1 : 0;
}
