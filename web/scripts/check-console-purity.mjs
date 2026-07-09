#!/usr/bin/env node
/**
 * check-console-purity — structural guard for the carbon-copy console (charter
 * D1/§3 P0.0 AC "zero shadcn/Tailwind class in console/**").
 *
 * Fails the web lint run if anything under web/src/console/** does any of:
 *   1. carries a Tailwind utility class in a `className` (the console owns its
 *      look through tokens.css; utility visuals are legacy inheritance);
 *   2. builds `className` from anything other than a plain string/template
 *      literal or a plain identifier bound (same-file) to one — no call
 *      expressions, ternaries, concatenation, or member access. This is an
 *      ALLOWLIST, not a denylist: `className={cn("flex","p-4")}` is banned
 *      outright because it isn't a plain literal, independent of whether "cn"
 *      is recognized — this is the actual fix for the reported bypass, not a
 *      pattern match on the callee name;
 *   3. imports from web/src/components/ui/** (shadcn) or components/shell/**
 *      (AppShell chrome) — the two visual worlds the console must not inherit;
 *   4. imports (by local binding name, however aliased/renamed, plus by module
 *      specifier for the single-purpose packages) a class-list utility — the
 *      cn/clsx/classnames/cva/twMerge bindings, or the clsx/classnames/
 *      class-variance-authority/tailwind-merge packages themselves;
 *   5. imports any .css/.scss/.sass/.less file other than `tokens.css`;
 *   6. uses Tailwind `@apply` in a .css file under console/**.
 *
 * Deliberately NOT implemented: a blanket scan of every string/template
 * literal in the file for Tailwind-pattern tokens. Tried it — it false-
 * positived on real merged console code the first time this file was
 * hardened: legitimate inline `style={{ position: "fixed" }}` values and
 * ordinary English test-description prose ("...right-edge caret...",
 * "...uppercase code...") collide with Tailwind's bare/prefixed token shapes
 * with no way to tell them apart without real scope analysis. Rule 2 already
 * makes it structurally impossible to route a computed string (from cn/clsx/
 * whatever) into `className` — a plain literal is the ONLY thing that
 * type-checks there — so the blanket scan added false positives with no
 * closed bypass to show for it.
 *
 * Heuristic, not a full parser (comments are stripped first so prose/docs
 * never trip it; nested braces in `className={...}` are depth-matched, not
 * regex-guessed). Prove it fires — each of these must exit 1, then delete:
 *   className="flex p-4"                    (rule 1)
 *   className={cn("flex", "p-4")}            (rule 2)
 *   import { cn } from "../../lib/utils"     (rule 4)
 *   import "../styles.css"                   (rule 5)
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
const tailwindTokensIn = (text) => text.split(/\s+/).filter(isTailwindToken);

/** Strip // and /* *‍/ comments so doc examples never trip the literal scans. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/**
 * Depth-matched extraction of every `attr={...}` expression container (handles
 * nested braces from object literals / calls, unlike a non-greedy regex) plus
 * every plain-quoted `attr="..."` / `attr='...'`.
 */
function attrValues(src, attrName) {
  const out = [];
  const re = new RegExp(`${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{)`, "g");
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m[1] != null || m[2] != null) {
      out.push({ kind: "literal", value: m[1] ?? m[2] });
      continue;
    }
    // Matched the opening `{` of an expression container — depth-match to find
    // the closing brace, so `className={cn({ "p-4": true })}` is captured whole.
    let depth = 1;
    let i = re.lastIndex;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
    out.push({ kind: "expr", value: src.slice(start, i - 1) });
    re.lastIndex = i;
  }
  return out;
}

/** Best-effort: is `name` a same-file `const name = "literal" | 'literal' | \`literal\`;`? */
function resolveIdentifierLiteral(src, name) {
  const re = new RegExp(
    `\\bconst\\s+${name}\\s*(?::\\s*[^=]+)?=\\s*(?:"([^"]*)"|'([^']*)'|\`([^\`]*)\`)`,
  );
  const m = re.exec(src);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? "";
}

const SIMPLE_LITERAL = /^["']([^"']*)["']$/;
const SIMPLE_TEMPLATE = /^`([^`]*)`$/; // no ${...} substitution allowed
const BARE_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Every className must resolve to a plain literal — otherwise it's banned outright. */
function checkClassNameAttrs(src, rel, violations) {
  for (const { kind, value } of attrValues(src, "className")) {
    if (kind === "literal") {
      const bad = tailwindTokensIn(value);
      if (bad.length) {
        violations.push(`${rel}: Tailwind utility class(es) in className — ${bad.join(", ")}`);
      }
      continue;
    }
    const trimmed = value.trim();
    let literalText;
    const lit = SIMPLE_LITERAL.exec(trimmed);
    const tmpl = SIMPLE_TEMPLATE.exec(trimmed);
    if (lit) {
      literalText = lit[1];
    } else if (tmpl && !tmpl[1].includes("${")) {
      literalText = tmpl[1];
    } else if (BARE_IDENTIFIER.test(trimmed)) {
      const resolved = resolveIdentifierLiteral(src, trimmed);
      if (resolved === null) {
        violations.push(
          `${rel}: className={${trimmed}} is not a same-file literal binding — className must be a plain literal or an identifier bound to one`,
        );
        continue;
      }
      literalText = resolved;
    } else {
      violations.push(
        `${rel}: className={${trimmed.slice(0, 60)}${trimmed.length > 60 ? "…" : ""}} is a computed expression (call/ternary/concat) — banned regardless of what it resolves to`,
      );
      continue;
    }
    const bad = tailwindTokensIn(literalText);
    if (bad.length) {
      violations.push(`${rel}: Tailwind utility class(es) in className — ${bad.join(", ")}`);
    }
  }
}

const BANNED_STRUCTURAL_IMPORT = /(?:^|\/)components\/(ui|shell)(?:\/|$)/;
// Single-purpose class-list packages: nothing legitimate to import from them
// besides class-list construction, so the whole module is banned outright.
const BANNED_UTIL_MODULE = /^(?:clsx|classnames|class-variance-authority|tailwind-merge)$/;
// lib/utils is a general shared-helper module (e.g. `safeLabel`) — NOT banned
// wholesale (that would block legitimate unrelated imports); only the
// specific class-list binding name is banned, via BANNED_BINDING_NAMES below,
// wherever it's imported from (lib/utils or anywhere else).
const BANNED_BINDING_NAMES = new Set(["cn", "clsx", "classnames", "cva", "twmerge", "tw"]);
const CSS_IMPORT = /\.(css|scss|sass|less)$/i;
const ALLOWED_CSS_IMPORT = /\/tokens\.css$|^\.\/tokens\.css$/;

/** Local bindings introduced by an `import <clause> from "mod"` clause. */
function importBindings(clause) {
  const inner = clause.replace(/[{}]/g, "").trim();
  if (!inner) return [];
  return inner
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const asMatch = /\bas\s+(\S+)$/.exec(s);
      if (asMatch) return asMatch[1];
      return s.replace(/^\*\s*/, "").trim();
    });
}

function checkImports(src, rel, violations) {
  const re = /import\s+(?:type\s+)?([^'";]+?)\s+from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const clause = m[1];
    const spec = m[2] ?? m[3];

    if (BANNED_STRUCTURAL_IMPORT.test(spec)) {
      violations.push(`${rel}: banned import "${spec}" (components/ui|shell)`);
    }
    if (BANNED_UTIL_MODULE.test(spec)) {
      violations.push(`${rel}: banned class-list utility import "${spec}"`);
    }
    if (CSS_IMPORT.test(spec) && !ALLOWED_CSS_IMPORT.test(spec)) {
      violations.push(`${rel}: banned CSS import "${spec}" — only tokens.css may be imported`);
    }
    if (clause) {
      for (const binding of importBindings(clause)) {
        if (BANNED_BINDING_NAMES.has(binding.toLowerCase())) {
          violations.push(`${rel}: banned class-list utility binding "${binding}" imported from "${spec}"`);
        }
      }
    }
  }
}

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
  const rawSrc = readFileSync(file, "utf8");

  if (/\.(tsx?|jsx?)$/.test(file)) {
    const src = stripComments(rawSrc);
    checkClassNameAttrs(src, rel, violations);
    checkImports(src, rel, violations);
  }

  if (/\.css$/.test(file) && /@apply\b/.test(rawSrc)) {
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
