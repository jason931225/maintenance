import { existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const generatorTag = "1.12.2";
const root = resolve(new URL("..", import.meta.url).pathname);
const cloneDir = resolve(root, `.cache/swift-openapi-generator-${generatorTag}`);
const generatorBin = resolve(cloneDir, ".build/release/swift-openapi-generator");
const outputDir = resolve(root, "clients/swift/Sources/MaintenanceAPIClient/Generated");
const config = resolve(root, "clients/swift/openapi-generator-config.yaml");
const inputSpec = resolve(root, "backend/openapi/openapi.yaml");

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

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
run(generatorBin, [
  "generate",
  "--config",
  config,
  "--output-directory",
  outputDir,
  inputSpec,
]);
