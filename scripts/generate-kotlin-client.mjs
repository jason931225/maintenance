import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hasJava, hasRunningDocker } from "./lib/toolchain-checks.mjs";

const generatorVersion = "7.23.0";
const root = fileURLToPath(new URL("..", import.meta.url));
const outputDir = resolve(root, "clients/kotlin");
const inputSpec = resolve(root, "backend/openapi/openapi.yaml");
const config = resolve(root, "clients/kotlin-generator-config.yaml");
const stagingRoot = resolve(root, ".cache/generated-clients");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) {
    const cause = result.error ? `: ${result.error.message}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}${cause}`);
  }
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

function dockerPath(path) {
  return `/workspace/${relative(root, path).split(sep).join("/")}`;
}

function removeBackupBestEffort(backupDir) {
  try {
    rmSync(backupDir, { recursive: true, force: true });
  } catch (error) {
    console.warn(`Warning: failed to remove previous Kotlin client backup ${backupDir}: ${error.message}`);
  }
}

function replaceDirectoryFromStaging(stagingDir, targetDir) {
  const backupDir = mkdtempSync(resolve(stagingRoot, "kotlin-previous-"));
  rmSync(backupDir, { recursive: true, force: true });
  let swapped = false;

  try {
    if (existsSync(targetDir)) {
      renameSync(targetDir, backupDir);
    }
    renameSync(stagingDir, targetDir);
    swapped = true;
  } catch (error) {
    if (!existsSync(targetDir) && existsSync(backupDir)) {
      renameSync(backupDir, targetDir);
    }
    throw error;
  } finally {
    if (swapped) {
      removeBackupBestEffort(backupDir);
    }
  }
}

const forceDocker = process.env.OPENAPI_GENERATOR_USE_DOCKER === "1";
const javaAvailable = hasJava();

// Preflight: openapi-generator-cli runs the generator JAR under Java, falling
// back to the openapitools Docker image when no JDK is on PATH. If neither a
// Java runtime nor a reachable Docker daemon exists, fail with an actionable
// message before touching the tracked generated client tree. CI installs
// Temurin 21, so the Java path is taken there and this never trips.
if ((forceDocker || !javaAvailable) && !hasRunningDocker()) {
  throw new Error(
    "Kotlin client generation needs either a Java 17+ runtime (preferred) or a " +
      "running Docker daemon, and found neither.\n" +
      "  - Install a JDK (e.g. `brew install temurin`) so `java -version` works, or\n" +
      "  - start Docker/Colima so `docker info` succeeds, then re-run `npm run gen:api:kotlin`.\n" +
      "Set OPENAPI_GENERATOR_USE_DOCKER=1 to force the Docker path when a JDK is present but undesired.",
  );
}

mkdirSync(stagingRoot, { recursive: true });
const stagingDir = mkdtempSync(resolve(stagingRoot, "kotlin-"));

const generatorArgs = [
  "generate",
  "-i",
  inputSpec,
  "-g",
  "kotlin",
  "-o",
  stagingDir,
  "-c",
  config,
  "--global-property",
  "apiTests=false,modelTests=false,apiDocs=false,modelDocs=false",
];

try {
  if (forceDocker || !javaAvailable) {
    run("docker", [
      "run",
      "--rm",
      "-v",
      `${root}:/workspace`,
      `openapitools/openapi-generator-cli:v${generatorVersion}`,
      "generate",
      "-i",
      dockerPath(inputSpec),
      "-g",
      "kotlin",
      "-o",
      dockerPath(stagingDir),
      "-c",
      dockerPath(config),
      "--global-property",
      "apiTests=false,modelTests=false,apiDocs=false,modelDocs=false",
    ]);
  } else {
    run(process.execPath, [resolve(root, "node_modules/@openapitools/openapi-generator-cli/main.js"), ...generatorArgs]);
  }

  if (!existsSync(resolve(stagingDir, "build.gradle"))) {
    throw new Error("Kotlin client generation did not produce clients/kotlin/build.gradle");
  }

  normalizeGeneratedTextFiles(stagingDir);
  chmodSync(resolve(stagingDir, "gradlew"), 0o755);
  replaceDirectoryFromStaging(stagingDir, outputDir);
} catch (error) {
  rmSync(stagingDir, { recursive: true, force: true });
  throw error;
}
