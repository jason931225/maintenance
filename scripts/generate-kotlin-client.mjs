import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, extname, resolve } from "node:path";

const generatorVersion = "7.23.0";
const root = resolve(new URL("..", import.meta.url).pathname);
const outputDir = resolve(root, "clients/kotlin");
const inputSpec = resolve(root, "backend/openapi/openapi.yaml");
const config = resolve(root, "clients/kotlin-generator-config.yaml");

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

function hasJava() {
  return spawnSync("java", ["-version"], { stdio: "ignore" }).status === 0;
}

function normalizeGeneratedTextFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      normalizeGeneratedTextFiles(path);
      continue;
    }
    if (!isGeneratedTextFile(path)) {
      continue;
    }

    const original = readFileSync(path, "utf8");
    const normalized = original.replace(/[ \t]+$/gm, "").replace(/\n*$/, "\n");
    if (normalized !== original) {
      writeFileSync(path, normalized, "utf8");
    }
  }
}

function isGeneratedTextFile(path) {
  const textExtensions = new Set([".bat", ".gradle", ".ignore", ".kt", ".md", ".pro", ".properties"]);
  const textFileNames = new Set(["FILES", "VERSION", "gradlew"]);
  return textExtensions.has(extname(path)) || textFileNames.has(basename(path));
}

rmSync(outputDir, { recursive: true, force: true });

const generatorArgs = [
  "generate",
  "-i",
  inputSpec,
  "-g",
  "kotlin",
  "-o",
  outputDir,
  "-c",
  config,
  "--global-property",
  "apiTests=false,modelTests=false,apiDocs=false,modelDocs=false",
];

if (process.env.OPENAPI_GENERATOR_USE_DOCKER === "1" || !hasJava()) {
  const dockerInput = "/workspace/backend/openapi/openapi.yaml";
  const dockerOutput = "/workspace/clients/kotlin";
  const dockerConfig = "/workspace/clients/kotlin-generator-config.yaml";
  run("docker", [
    "run",
    "--rm",
    "-v",
    `${root}:/workspace`,
    `openapitools/openapi-generator-cli:v${generatorVersion}`,
    "generate",
    "-i",
    dockerInput,
    "-g",
    "kotlin",
    "-o",
    dockerOutput,
    "-c",
    dockerConfig,
    "--global-property",
    "apiTests=false,modelTests=false,apiDocs=false,modelDocs=false",
  ]);
} else {
  run("npx", ["openapi-generator-cli", ...generatorArgs]);
}

if (!existsSync(resolve(outputDir, "build.gradle"))) {
  throw new Error("Kotlin client generation did not produce clients/kotlin/build.gradle");
}

normalizeGeneratedTextFiles(outputDir);
chmodSync(resolve(outputDir, "gradlew"), 0o755);
