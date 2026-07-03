import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
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
  replaceDirectoryFromStaging(stagingDir, outputDir);
} catch (error) {
  rmSync(stagingDir, { recursive: true, force: true });
  throw error;
}
