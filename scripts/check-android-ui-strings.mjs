import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const uiRoot = join(repoRoot, "android/app/src/main/kotlin/com/maintenance/field/ui");
const stringsPath = join(repoRoot, "android/app/src/main/res/values/strings.xml");
const kotlinStringLiteral = /"""[\s\S]*?"""|"(?:\\.|[^"\\])*"/g;
const hangul = /[\u3131-\uD79D]/;

async function collectKotlinFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectKotlinFiles(path);
      }
      if (entry.isFile() && entry.name.endsWith(".kt")) {
        return [path];
      }
      return [];
    }),
  );
  return files.flat();
}

function parseAndroidStringKeys(xml) {
  return new Set(
    [...xml.matchAll(/<string\s+name="([^"]+)"(?:\s+[^>]*)?>[\s\S]*?<\/string>/g)].map(
      ([, key]) => key,
    ),
  );
}

function literalValue(raw) {
  if (raw.startsWith('"""')) {
    return raw.slice(3, -3);
  }
  return raw.slice(1, -1);
}

function lineNumber(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

function isUiTextLiteral(content, literalStart) {
  const prefix = content.slice(Math.max(0, literalStart - 80), literalStart);
  return (
    /(?:^|[^\w.])(?:Text|BasicText)\s*\(\s*$/s.test(prefix) ||
    /(?:^|[^\w.])(?:text|label|placeholder|supportingText|contentDescription)\s*=\s*$/s.test(prefix) ||
    /(?:^|[^\w.])showSnackbar\s*\(\s*$/s.test(prefix)
  );
}

const stringKeys = parseAndroidStringKeys(await readFile(stringsPath, "utf8"));
const files = await collectKotlinFiles(uiRoot);
const violations = [];

for (const file of files) {
  const content = await readFile(file, "utf8");
  const displayPath = relative(repoRoot, file).split(/[\\/]/).join("/");

  for (const match of content.matchAll(kotlinStringLiteral)) {
    const [raw] = match;
    const value = literalValue(raw);
    const line = lineNumber(content, match.index);
    if (hangul.test(value)) {
      violations.push(`${displayPath}:${line}: Korean UI literal ${raw} must move to strings.xml`);
    } else if (value.trim() && isUiTextLiteral(content, match.index)) {
      violations.push(`${displayPath}:${line}: UI text literal ${raw} must use stringResource(R.string.*)`);
    }
  }

  for (const match of content.matchAll(/R\.string\.([A-Za-z0-9_]+)/g)) {
    const [, key] = match;
    if (!stringKeys.has(key)) {
      violations.push(`${displayPath}:${lineNumber(content, match.index)}: missing strings.xml key "${key}"`);
    }
  }
}

if (violations.length > 0) {
  console.error("Android Compose UI strings must use android/app/src/main/res/values/strings.xml:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log(`Checked ${files.length} Android Compose source files against ${stringKeys.size} string keys.`);
