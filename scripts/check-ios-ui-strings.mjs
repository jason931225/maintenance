import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const appRoot = join(repoRoot, "ios/Sources/MaintenanceFieldApp");
const coreLabelPath = join(repoRoot, "ios/Sources/MaintenanceFieldCore/FieldLabels.swift");
const coreMessengerPath = join(repoRoot, "ios/Sources/MaintenanceFieldCore/Messenger.swift");
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

function isInsideComputedProperty(content, literalStart, propertyName) {
  const headerPattern = new RegExp(`var\\s+${propertyName}\\s*:`, "g");
  const prefix = content.slice(0, literalStart);
  const headers = [...prefix.matchAll(headerPattern)];
  const header = headers.at(-1);
  if (!header) return false;

  const openingBrace = content.indexOf("{", header.index);
  if (openingBrace < 0 || openingBrace > literalStart) return false;

  let depth = 0;
  for (let index = openingBrace; index < content.length; index += 1) {
    const char = content[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (index >= literalStart) return depth > 0;
    if (depth === 0) return false;
  }
  return false;
}

const localizableKeys = parseLocalizableKeys(await readFile(stringsPath, "utf8"));
const files = [...(await collectSwiftFiles(appRoot)), coreLabelPath, coreMessengerPath];
const violations = [];

for (const file of files) {
  const content = await readFile(file, "utf8");
  const displayPath = relative(repoRoot, file).split(/[\\/]/).join("/");
  const isFieldLabelsFile = file === coreLabelPath;
  const isMessengerFile = file === coreMessengerPath;

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
      (isFieldLabelsFile && isFieldLabelReturn(content, match.index)) ||
      (isMessengerFile && isInsideComputedProperty(content, match.index, "displayTitle"));

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
