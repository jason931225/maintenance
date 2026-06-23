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

function hasRunningDocker() {
  // `docker info` exits non-zero (and prints to stderr) when the CLI is present
  // but no daemon is reachable. spawnSync.status is null when `docker` itself is
  // not installed (ENOENT) — treat both as "no usable Docker". The timeout keeps
  // a wedged daemon socket from stalling the preflight indefinitely.
  return spawnSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 }).status === 0;
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

const forceDocker = process.env.OPENAPI_GENERATOR_USE_DOCKER === "1";
const javaAvailable = hasJava();

// Preflight: openapi-generator-cli runs the generator JAR under Java, falling
// back to the openapitools Docker image when no JDK is on PATH. If neither a
// Java runtime nor a reachable Docker daemon exists, fail with an actionable
// message here rather than letting the (webpacked, minified) wrapper throw a
// "Unable to locate a Java Runtime" stack trace whose trailing "Node.js vXX"
// footer is easily misread as a Node/ESM incompatibility (it is not). CI
// installs Temurin 21, so the Java path is taken there and this never trips.
if ((forceDocker || !javaAvailable) && !hasRunningDocker()) {
  throw new Error(
    "Kotlin client generation needs either a Java 17+ runtime (preferred) or a " +
      "running Docker daemon, and found neither.\n" +
      "  - Install a JDK (e.g. `brew install temurin`) so `java -version` works, or\n" +
      "  - start Docker/Colima so `docker info` succeeds, then re-run `npm run gen:api:kotlin`.\n" +
      "Set OPENAPI_GENERATOR_USE_DOCKER=1 to force the Docker path when a JDK is present but undesired.",
  );
}

if (forceDocker || !javaAvailable) {
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
