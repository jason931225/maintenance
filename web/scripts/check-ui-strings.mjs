import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
const allowedDirectories = ["src/i18n/", "src/test/"];
const allowedFilePatterns = [/\.test\.tsx?$/, /\.d\.ts$/];
const hangulLiteral = /(["'`])(?:\\.|(?!\1)[\s\S])*[\u3131-\uD79D](?:\\.|(?!\1)[\s\S])*\1/g;
// Strip comments before scanning for Hangul-bearing string literals: a `"`/`'`
// literal followed later by a Korean `//` or `/* */` comment would otherwise let
// the greedy literal regex run across the newline into the comment and flag the
// comment's Hangul as a fake hardcoded string.
const comments = /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g;
const commentsAndStringLiterals =
  /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|(["'`])(?:\\.|(?!\1)[\s\S])*\1/g;
const hangul = /[\u3131-\uD79D]/;

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectFiles(path);
      }
      if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) {
        return [path];
      }
      return [];
    }),
  );
  return files.flat();
}

const files = await collectFiles(sourceRoot);
const violations = [];

for (const file of files) {
  const relToWeb = relative(webRoot, file);
  const normalized = relToWeb.split(/[\\/]/).join("/");
  const displayPath = relative(process.cwd(), file).split(/[\\/]/).join("/");
  const inAllowedDirectory = allowedDirectories.some((segment) =>
    normalized.startsWith(segment),
  );
  const isAllowedFile = allowedFilePatterns.some((pattern) =>
    pattern.test(normalized),
  );
  if (inAllowedDirectory || isAllowedFile) {
    continue;
  }

  const content = await readFile(file, "utf8");
  const matches = content.replace(comments, "").match(hangulLiteral);
  if (matches) {
    violations.push(`${displayPath}: ${matches.join(", ")}`);
  }

  const withoutCommentsAndStrings = content.replace(commentsAndStringLiterals, "");
  if (hangul.test(withoutCommentsAndStrings)) {
    violations.push(`${displayPath}: Hangul JSX/text outside the i18n resource file`);
  }
}

if (violations.length > 0) {
  console.error("Hardcoded Korean UI strings must live under web/src/i18n:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}
