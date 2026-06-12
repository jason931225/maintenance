import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const appRoot = join(repoRoot, "ios/Sources/MaintenanceFieldApp");
const coreLabelPath = join(repoRoot, "ios/Sources/MaintenanceFieldCore/FieldLabels.swift");
const stringsPath = join(
  repoRoot,
  "ios/Sources/MaintenanceFieldApp/Resources/ko.lproj/Localizable.strings",
);
const swiftStringLiteral = /"(?:\\.|[^"\\])*"/g;
const hangul = /[\u3131-\uD79D]/;
const uiCallPatterns = [
  /(?:^|[^\w.])Text\s*\(\s*$/s,
  /(?:^|[^\w.])Label\s*\(\s*$/s,
  /(?:^|[^\w.])Button\s*\(\s*$/s,
  /(?:^|[^\w.])ProgressView\s*\(\s*$/s,
  /(?:^|[^\w.])LabeledContent\s*\(\s*$/s,
  /(?:^|[^\w.])Picker\s*\(\s*$/s,
  /(?:^|[^\w.])String\s*\(\s*localized:\s*$/s,
  /(?:^|[^\w.])localizedString\s*\(\s*$/s,
];

async function collectSwiftFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectSwiftFiles(path);
      }
      if (entry.isFile() && entry.name.endsWith(".swift")) {
        return [path];
      }
      return [];
    }),
  );
  return files.flat();
}

function parseLocalizableKeys(content) {
  return new Set(
    [...content.matchAll(/"((?:\\"|[^"])*)"\s*=\s*"((?:\\"|[^"])*)";/g)].map(([, key]) =>
      key.replace(/\\"/g, '"'),
    ),
  );
}

function literalValue(raw) {
  return raw.slice(1, -1);
}

function lineNumber(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

function uiCallUsesLocalizedKey(content, literalStart) {
  const prefix = content.slice(Math.max(0, literalStart - 80), literalStart);
  return uiCallPatterns.some((pattern) => pattern.test(prefix));
}

function isMessageKeyAssignment(content, literalStart) {
  const prefix = content.slice(Math.max(0, literalStart - 40), literalStart);
  return /(?:^|[^\w.])messageKey\s*=\s*$/s.test(prefix);
}

function isFieldLabelReturn(content, literalStart) {
  const prefix = content.slice(Math.max(0, literalStart - 20), literalStart);
  return /:\s*$/s.test(prefix);
}

const localizableKeys = parseLocalizableKeys(await readFile(stringsPath, "utf8"));
const files = [...(await collectSwiftFiles(appRoot)), coreLabelPath];
const violations = [];

for (const file of files) {
  const content = await readFile(file, "utf8");
  const displayPath = relative(repoRoot, file).split(/[\\/]/).join("/");
  const isFieldLabelsFile = file === coreLabelPath;

  for (const match of content.matchAll(swiftStringLiteral)) {
    const [raw] = match;
    const value = literalValue(raw);
    const line = lineNumber(content, match.index);

    if (hangul.test(value)) {
      violations.push(`${displayPath}:${line}: Korean UI literal ${raw} must move to Localizable.strings`);
      continue;
    }

    const shouldResolveKey =
      uiCallUsesLocalizedKey(content, match.index) ||
      isMessageKeyAssignment(content, match.index) ||
      (isFieldLabelsFile && isFieldLabelReturn(content, match.index));

    if (shouldResolveKey && !localizableKeys.has(value)) {
      violations.push(`${displayPath}:${line}: localized key "${value}" is missing from Localizable.strings`);
    }
  }
}

if (violations.length > 0) {
  console.error("iOS SwiftUI strings must resolve through Localizable.strings:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log(`Checked ${files.length} iOS Swift files against ${localizableKeys.size} localized keys.`);
