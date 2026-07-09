import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const generatorTag = "1.12.2";
const root = fileURLToPath(new URL("..", import.meta.url));
const cloneDir = resolve(root, `.cache/swift-openapi-generator-${generatorTag}`);
const generatorBin = resolve(cloneDir, ".build/release/swift-openapi-generator");
const outputDir = resolve(root, "clients/swift/Sources/MaintenanceAPIClient/Generated");
const config = resolve(root, "clients/swift/openapi-generator-config.yaml");
const inputSpec = resolve(root, "backend/openapi/openapi.yaml");
const stagingRoot = resolve(root, ".cache/generated-clients");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`);
  }
}

function patchKnownGeneratorGaps(stagingDir) {
  // swift-openapi-generator 1.12 skips the `null` branch for a required
  // oneOf[$ref, null] property and emits an empty struct. The OpenAPI contract
  // intentionally models SeriesByInstanceResponse.series as a present key whose
  // value may be null, so patch this generated shape until the generator supports
  // that schema form natively.
  const typesFile = resolve(stagingDir, "Types.swift");
  let text = readFileSync(typesFile, "utf8");
  const emptySeriesByInstance = `        /// The series an instance belongs to, or null.
        ///
        /// - Remark: Generated from \`#/components/schemas/SeriesByInstanceResponse\`.
        public struct SeriesByInstanceResponse: Codable, Hashable, Sendable {
            /// Creates a new \`SeriesByInstanceResponse\`.
            public init() {}
        }`;
  const patchedSeriesByInstance = `        /// The series an instance belongs to, or null.
        ///
        /// - Remark: Generated from \`#/components/schemas/SeriesByInstanceResponse\`.
        public struct SeriesByInstanceResponse: Codable, Hashable, Sendable {
            /// - Remark: Generated from \`#/components/schemas/SeriesByInstanceResponse/series\`.
            public var series: Components.Schemas.SeriesHead?
            /// Creates a new \`SeriesByInstanceResponse\`.
            ///
            /// - Parameters:
            ///   - series:
            public init(series: Components.Schemas.SeriesHead? = nil) {
                self.series = series
            }
            public enum CodingKeys: String, CodingKey {
                case series
            }
        }`;
  if (text.includes(emptySeriesByInstance)) {
    text = text.replace(emptySeriesByInstance, patchedSeriesByInstance);
    writeFileSync(typesFile, text, "utf8");
  }
}

function replaceDirectoryFromStaging(stagingDir, targetDir) {
  const backupDir = mkdtempSync(resolve(stagingRoot, "swift-previous-"));
  rmSync(backupDir, { recursive: true, force: true });

  try {
    if (existsSync(targetDir)) {
      renameSync(targetDir, backupDir);
    }
    renameSync(stagingDir, targetDir);
    rmSync(backupDir, { recursive: true, force: true });
  } catch (error) {
    if (!existsSync(targetDir) && existsSync(backupDir)) {
      renameSync(backupDir, targetDir);
    }
    throw error;
  }
}

if (!existsSync(cloneDir)) {
  mkdirSync(resolve(root, ".cache"), { recursive: true });
  run("git", [
    "-c",
    "advice.detachedHead=false",
    "clone",
    "--branch",
    generatorTag,
    "--depth",
    "1",
    "https://github.com/apple/swift-openapi-generator",
    cloneDir,
  ]);
}

if (!existsSync(generatorBin)) {
  run("swift", [
    "build",
    "--package-path",
    cloneDir,
    "--configuration",
    "release",
    "--product",
    "swift-openapi-generator",
  ]);
}

mkdirSync(stagingRoot, { recursive: true });
const stagingDir = mkdtempSync(resolve(stagingRoot, "swift-"));

try {
  run(generatorBin, [
    "generate",
    "--config",
    config,
    "--output-directory",
    stagingDir,
    inputSpec,
  ]);
  patchKnownGeneratorGaps(stagingDir);
  replaceDirectoryFromStaging(stagingDir, outputDir);
} catch (error) {
  rmSync(stagingDir, { recursive: true, force: true });
  throw error;
}
