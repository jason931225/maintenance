import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = join(webRoot, "src");
const consoleRoot = join(sourceRoot, "console");
const tokenPath = join(consoleRoot, "tokens.css");
const allowedExternalImports = new Set(["qrcode.react", "react", "react-router-dom"]);
const allowedRelativeRoots = [
  "src/api/",
  "src/auth/",
  "src/console/",
  "src/context/",
  "src/i18n/",
];
const forbiddenImportFragments = [
  "@radix-ui/",
  "class-variance-authority",
  "clsx",
  "components/ui",
  "features/",
  "lucide-react",
  "pages/",
  "shadcn",
  "tailwind",
  "tailwind-merge",
];
const requiredCanvasTokens = [
  "canvas-grid-bg",
  "canvas-grid-bd",
  "canvas-block-bg",
  "canvas-block-border",
  "canvas-block-shadow",
  "canvas-block-trigger-bg",
  "canvas-block-trigger-bd",
  "canvas-block-trigger-tx",
  "canvas-block-condition-bg",
  "canvas-block-condition-bd",
  "canvas-block-condition-tx",
  "canvas-block-branch-bg",
  "canvas-block-branch-bd",
  "canvas-block-branch-tx",
  "canvas-block-action-bg",
  "canvas-block-action-bd",
  "canvas-block-action-tx",
  "timeline-dot-bg",
  "timeline-dot-bd",
];

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return collectFiles(path);
      if (entry.isFile() && /\.(?:css|tsx?|mts|cts)$/.test(entry.name)) return [path];
      return [];
    }),
  );
  return files.flat();
}

function displayPath(path) {
  return relative(webRoot, path).split(/[\\/]/).join("/");
}

function sourcePath(path) {
  return relative(webRoot, path).split(/[\\/]/).join("/");
}

function relativeImportIsAllowed(file, specifier) {
  const resolved = resolve(dirname(file), specifier);
  const rel = sourcePath(resolved);
  return allowedRelativeRoots.some((root) => rel === root.slice(0, -1) || rel.startsWith(root));
}

function checkImports(file, content, violations) {
  const importOrExport = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of content.matchAll(importOrExport)) {
    const specifier = match[1];
    const normalized = specifier.split(/[\\/]/).join("/");
    const forbidden = forbiddenImportFragments.find((fragment) => normalized.includes(fragment));
    if (forbidden) {
      violations.push(`${displayPath(file)}: forbidden console import '${specifier}' (${forbidden})`);
      continue;
    }
    if (specifier.startsWith(".")) {
      if (!relativeImportIsAllowed(file, specifier)) {
        violations.push(`${displayPath(file)}: relative import escapes console/i18n/api/auth/context '${specifier}'`);
      }
      continue;
    }
    if (!allowedExternalImports.has(specifier)) {
      violations.push(`${displayPath(file)}: external import '${specifier}' is not on the console allowlist`);
    }
  }
}

function checkClassNames(file, content, violations) {
  const literalClassName = /className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{(["'`])([^"'`{}]+)\3\})/g;
  for (const match of content.matchAll(literalClassName)) {
    const value = (match[1] ?? match[2] ?? match[4] ?? "").trim();
    if (value !== "console") {
      violations.push(`${displayPath(file)}: className '${value}' is not console-pure; use tokenized inline styles`);
    }
  }

  const dynamicClassName = /className\s*=\s*\{(?!\s*["'`]console["'`]\s*\})/g;
  if (dynamicClassName.test(content)) {
    violations.push(`${displayPath(file)}: dynamic className is not console-pure; use tokenized inline styles`);
  }
}

function checkTokenUsage(file, content, tokenNames, violations) {
  for (const match of content.matchAll(/var\(\s*--([A-Za-z0-9-]+)/g)) {
    const tokenName = match[1];
    if (!tokenNames.has(tokenName)) {
      violations.push(`${displayPath(file)}: uses undefined console token --${tokenName}`);
    }
  }
}

const tokenContent = await readFile(tokenPath, "utf8");
const tokenNames = new Set([...tokenContent.matchAll(/--([A-Za-z0-9-]+)\s*:/g)].map((match) => match[1]));
const violations = [];

for (const token of requiredCanvasTokens) {
  if (!tokenNames.has(token)) {
    violations.push(`${displayPath(tokenPath)}: missing required canvas token --${token}`);
  }
}

const files = (await collectFiles(consoleRoot)).filter((file) => !/\.test\.tsx?$/.test(file));
for (const file of files) {
  const content = await readFile(file, "utf8");
  if (content.includes("@tailwind")) {
    violations.push(`${displayPath(file)}: @tailwind directives are forbidden in console scope`);
  }
  if (/\.[A-Za-z0-9_-]*shadcn[A-Za-z0-9_-]*/i.test(content)) {
    violations.push(`${displayPath(file)}: shadcn marker detected in console scope`);
  }
  if (/\.[cm]?[jt]sx?$/.test(file)) {
    checkImports(file, content, violations);
    checkClassNames(file, content, violations);
  }
  checkTokenUsage(file, content, tokenNames, violations);
}

if (violations.length > 0) {
  console.error("Console purity check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Console purity check passed (${String(files.length)} files).`);
