#!/usr/bin/env node
/**
 * check-console-purity — structural guard for the carbon-copy console (charter
 * D1/§3 P0.0 AC "zero shadcn/Tailwind class in console/**").
 *
 * Fails the web lint run if anything under web/src/console/** does either of:
 *   1. carries a Tailwind utility class in a `className` (the console owns its
 *      look through tokens.css; utility visuals are legacy inheritance);
 *   2. imports from web/src/components/ui/** (shadcn) or components/shell/**
 *      (AppShell chrome) — the two visual worlds the console must not inherit;
 *   3. uses Tailwind `@apply` in a .css file under console/**.
 *
 * Heuristic, not a full parser: it inspects only `className` attribute values
 * and import specifiers, so prose/comments never trip it. Prove it fires:
 *   printf 'export const X = () => <div className="flex p-4" />;\n' \
 *     > web/src/console/__purity_probe.tsx && node scripts/check-console-purity.mjs
 * (expect exit 1), then delete the probe.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const consoleDir = join(webRoot, "src", "console");

// Tailwind utility shapes: prefixed utilities (p-4, text-sm, bg-white, w-full,
// gap-2, rounded-lg, -mx-2, md:flex, hover:bg-…) and common bare utilities.
const PREFIXED =
  /^-?(?:(?:sm|md|lg|xl|2xl|hover|focus|focus-visible|active|disabled|group-hover|dark|first|last|odd|even):)*(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|w|h|min|max|gap|space|text|bg|border|rounded|flex|grid|grid-cols|grid-rows|col|row|order|items|justify|self|content|place|font|leading|tracking|shadow|ring|divide|z|top|left|right|bottom|inset|opacity|overflow|object|cursor|transition|duration|ease|scale|rotate|translate|basis|shrink|grow)-[a-z0-9./[\]%#-]+$/;
const BARE =
  /^-?(?:(?:sm|md|lg|xl|2xl|hover|focus|active|disabled|group-hover|dark):)*(?:flex|grid|block|inline|inline-block|inline-flex|hidden|table|contents|absolute|relative|fixed|sticky|static|container|truncate|uppercase|lowercase|capitalize|italic|underline|antialiased|isolate|flow-root)$/;

const isTailwindToken = (t) => t.length > 0 && (PREFIXED.test(t) || BARE.test(t));

/** Pull the string content out of each className attribute in a TS/TSX source. */
function classNameValues(src) {
  const out = [];
  const re = /className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{"([^"]*)"\}|\{'([^']*)'\})/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const v = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
    if (v != null) out.push(v);
  }
  return out;
}

function importSpecifiers(src) {
  const out = [];
  const re = /(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1] ?? m[2]);
  return out;
}

const BANNED_IMPORT = /(?:^|\/)components\/(ui|shell)(?:\/|$)/;

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files.push(...walk(p));
    else files.push(p);
  }
  return files;
}

const violations = [];
let files;
try {
  files = walk(consoleDir);
} catch {
  // No console dir yet — nothing to guard.
  process.exit(0);
}

for (const file of files) {
  const rel = relative(webRoot, file);
  const src = readFileSync(file, "utf8");

  if (/\.(tsx?|jsx?)$/.test(file)) {
    for (const cn of classNameValues(src)) {
      const bad = cn.split(/\s+/).filter(isTailwindToken);
      if (bad.length) {
        violations.push(`${rel}: Tailwind utility class(es) in className — ${bad.join(", ")}`);
      }
    }
    for (const spec of importSpecifiers(src)) {
      if (BANNED_IMPORT.test(spec)) {
        violations.push(`${rel}: banned import "${spec}" (components/ui|shell)`);
      }
    }
  }

  if (/\.css$/.test(file) && /@apply\b/.test(src)) {
    violations.push(`${rel}: Tailwind @apply is banned in console CSS`);
  }
}

if (violations.length) {
  console.error("check-console-purity FAILED — zero-visual-inheritance guard:");
  for (const v of violations) console.error(`  ✗ ${v}`);
  console.error(
    "\nThe carbon-copy console must style itself only through console/tokens.css.",
  );
  process.exit(1);
}

console.log(`check-console-purity OK — ${files.length} file(s) under web/src/console clean.`);
