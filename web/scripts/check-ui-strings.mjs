import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
const allowedDirectories = ["src/i18n/", "src/test/"];
const allowedFilePatterns = [/\.test\.tsx?$/, /\.d\.ts$/];
const hangulLiteral = /(["'`])(?:(?!\1).)*[\u3131-\uD79D](?:(?!\1).)*\1/g;

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
  const rel = relative(process.cwd(), file);
  const normalized = rel.split(/[\\/]/).join("/");
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
  const matches = content.match(hangulLiteral);
  if (matches) {
    violations.push(`${normalized}: ${matches.join(", ")}`);
  }
}

if (violations.length > 0) {
  console.error("Hardcoded Korean UI strings must live under src/i18n:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}
