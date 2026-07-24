import {
  chmodSync,
  cpSync,
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
import {
  collectSupportedKotlinDiscriminatorUnions,
  patchGeneratedKotlinMappedUnions,
} from "./lib/kotlin-discriminator-unions.mjs";

const generatorVersion = "7.23.0";
const root = fileURLToPath(new URL("..", import.meta.url));
const outputDir = resolve(root, "clients/kotlin");
const inputSpec = resolve(root, "backend/openapi/openapi.yaml");
const config = resolve(root, "clients/kotlin-generator-config.yaml");
const templateDir = resolve(root, "clients/kotlin-generator-templates");
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

function replaceInGeneratedFile(path, replacements) {
  let content = readFileSync(path, "utf8");
  let updated = content;
  for (const [from, to] of replacements) {
    if (!updated.includes(from)) {
      throw new Error(`Kotlin client generator patch target not found in ${relative(root, path)}`);
    }
    updated = updated.replaceAll(from, to);
  }
  if (updated !== content) {
    writeFileSync(path, updated, "utf8");
  }
}

function patchKnownGeneratorGaps(directory) {
  const apiClientPath = resolve(
    directory,
    "src/main/kotlin/com/maintenance/api/client/infrastructure/ApiClient.kt",
  );
  replaceInGeneratedFile(apiClientPath, [
    [
      `        // take content-type/accept from spec or set to default (application/json) if not defined
        if (requestConfig.body != null && requestConfig.headers[CONTENT_TYPE].isNullOrEmpty()) {
            requestConfig.headers[CONTENT_TYPE] = JSON_MEDIA_TYPE
        }
        if (requestConfig.headers[ACCEPT].isNullOrEmpty()) {
            requestConfig.headers[ACCEPT] = JSON_MEDIA_TYPE
        }
        val headers = requestConfig.headers

        if (headers[ACCEPT].isNullOrEmpty()) {
            throw kotlin.IllegalStateException("Missing ACCEPT header. This is required.")
        }

        val contentType = if (headers[CONTENT_TYPE] != null) {
            // TODO: support multiple contentType options here.
            (headers[CONTENT_TYPE] as String).substringBefore(";").lowercase(Locale.US)
        } else {
            null
        }
`,
      `        // take content-type/accept from spec or set to default (application/json) if not defined
        val inferredContentType = if (requestConfig.body is Map<*, *> && requestConfig.body.values.all { it is PartConfig<*> }) {
            FORM_DATA_MEDIA_TYPE
        } else {
            null
        }
        if (requestConfig.body != null && requestConfig.headers[CONTENT_TYPE].isNullOrEmpty() && inferredContentType == null) {
            requestConfig.headers[CONTENT_TYPE] = JSON_MEDIA_TYPE
        }
        if (requestConfig.headers[ACCEPT].isNullOrEmpty()) {
            requestConfig.headers[ACCEPT] = JSON_MEDIA_TYPE
        }
        val headers = requestConfig.headers

        if (headers[ACCEPT].isNullOrEmpty()) {
            throw kotlin.IllegalStateException("Missing ACCEPT header. This is required.")
        }

        val contentType = if (headers[CONTENT_TYPE] != null) {
            // TODO: support multiple contentType options here.
            (headers[CONTENT_TYPE] as String).substringBefore(";").lowercase(Locale.US)
        } else {
            inferredContentType
        }
`,
    ],
  ]);

  const apiDir = resolve(directory, "src/main/kotlin/com/maintenance/api/client/api");
  for (const entry of readdirSync(apiDir, { withFileTypes: true })) {
    if (!entry.isFile() || extname(entry.name) !== ".kt") {
      continue;
    }
    const path = resolve(apiDir, entry.name);
    const content = readFileSync(path, "utf8");
    const updated = content.replaceAll(
      `val localVariableHeaders: MutableMap<String, String> = mutableMapOf("Content-Type" to "multipart/form-data")`,
      `val localVariableHeaders: MutableMap<String, String> = mutableMapOf()`,
    );
    if (updated !== content) {
      writeFileSync(path, updated, "utf8");
    }
  }

  replaceInGeneratedFile(resolve(apiDir, "EmployeesApi.kt"), [
    [`fun exportEmployeesCsvRequestConfig() : RequestConfig<Unit> {
        val localVariableBody = null
        val localVariableQuery: MultiValueMap = mutableMapOf()
        val localVariableHeaders: MutableMap<String, String> = mutableMapOf()
        localVariableHeaders["Accept"] = "application/json"`,
     `fun exportEmployeesCsvRequestConfig() : RequestConfig<Unit> {
        val localVariableBody = null
        val localVariableQuery: MultiValueMap = mutableMapOf()
        val localVariableHeaders: MutableMap<String, String> = mutableMapOf()
        localVariableHeaders["Accept"] = "text/csv"`],
  ]);

  replaceInGeneratedFile(resolve(apiDir, "ExportsApi.kt"), [
    [`localVariableHeaders["Accept"] = "application/json"`,
     `localVariableHeaders["Accept"] = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"`],
  ]);
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

const repoOwnedKotlinClientPaths = ["src/test"];

function preserveRepoOwnedKotlinClientFiles(sourceDir, stagingDir) {
  for (const relativePath of repoOwnedKotlinClientPaths) {
    const source = resolve(sourceDir, relativePath);
    if (!existsSync(source)) {
      continue;
    }

    const destination = resolve(stagingDir, relativePath);
    mkdirSync(resolve(destination, ".."), { recursive: true });
    cpSync(source, destination, { recursive: true, force: true });
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
  "-t",
  templateDir,
  "--global-property",
  "apiTests=false,modelTests=false,apiDocs=false,modelDocs=false",
];

try {
  const discriminatorUnions = await collectSupportedKotlinDiscriminatorUnions(new URL("../backend/openapi/openapi.yaml", import.meta.url));
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
      "-t",
      dockerPath(templateDir),
      "--global-property",
      "apiTests=false,modelTests=false,apiDocs=false,modelDocs=false",
    ]);
  } else {
    run(process.execPath, [resolve(root, "node_modules/@openapitools/openapi-generator-cli/main.js"), ...generatorArgs]);
  }

  if (!existsSync(resolve(stagingDir, "build.gradle"))) {
    throw new Error("Kotlin client generation did not produce clients/kotlin/build.gradle");
  }

  // The generated client source stays generator-owned, but contract tests and
  // fixtures under src/test are repo-owned gates and must survive regeneration.
  preserveRepoOwnedKotlinClientFiles(outputDir, stagingDir);

  // Guardrail: keep the client split into per-domain Api classes. openapi-generator
  // only emits DefaultApi.kt when an operation carries no `tags:` — that is exactly
  // how the 22.8k-line monolith (and its kotlinc GC-overhead OOM) arose. Fail closed
  // so an untagged route can never regenerate the monolith unnoticed; this runs in CI
  // through the api-drift regeneration, not just locally.
  if (existsSync(resolve(stagingDir, "src/main/kotlin/com/maintenance/api/client/api/DefaultApi.kt"))) {
    throw new Error(
      "Kotlin generation produced DefaultApi.kt: an openapi.yaml operation is missing a `tags:` entry.\n" +
        "Every operation must be tagged (domain = its /api/v1/<segment> path) so the client stays split per-domain.\n" +
        "Find it: a path whose get/post/put/patch/delete block has no `tags:` list.",
    );
  }

  patchKnownGeneratorGaps(stagingDir);
  patchGeneratedKotlinMappedUnions({ stagingDir, unions: discriminatorUnions });
  normalizeGeneratedTextFiles(stagingDir);
  writeFileSync(
    resolve(stagingDir, "gradle.properties"),
    [
      "# Generated by scripts/generate-kotlin-client.mjs.",
      "# The split tag-based Kotlin client can exceed the Gradle/Kotlin default heap on GitHub runners.",
      "org.gradle.jvmargs=-Xmx3g -Dfile.encoding=UTF-8",
      "kotlin.daemon.jvmargs=-Xmx3g",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(resolve(stagingDir, "gradlew"), 0o755);
  replaceDirectoryFromStaging(stagingDir, outputDir);
} catch (error) {
  rmSync(stagingDir, { recursive: true, force: true });
  throw error;
}
