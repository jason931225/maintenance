import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const inputSpec = resolve(root, "backend/openapi/openapi.yaml");
const outputFile = resolve(root, "clients/ts/src/schema.d.ts");
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

function removeBackupBestEffort(backupDir) {
  try {
    rmSync(backupDir, { recursive: true, force: true });
  } catch (error) {
    console.warn(`Warning: failed to remove previous TypeScript client backup ${backupDir}: ${error.message}`);
  }
}

function replaceFileFromStaging(stagingFile, targetFile) {
  mkdirSync(dirname(targetFile), { recursive: true });
  const backupDir = mkdtempSync(resolve(stagingRoot, "ts-previous-"));
  const backupFile = resolve(backupDir, "schema.d.ts.previous");
  let swapped = false;

  try {
    if (existsSync(targetFile)) {
      renameSync(targetFile, backupFile);
    }
    renameSync(stagingFile, targetFile);
    swapped = true;
  } catch (error) {
    if (!existsSync(targetFile) && existsSync(backupFile)) {
      renameSync(backupFile, targetFile);
    }
    throw error;
  } finally {
    if (swapped) {
      removeBackupBestEffort(backupDir);
    }
  }
}

mkdirSync(stagingRoot, { recursive: true });
const stagingDir = mkdtempSync(resolve(stagingRoot, "ts-"));
const stagingFile = resolve(stagingDir, "schema.d.ts");

try {
  run("npx", ["openapi-typescript", inputSpec, "-o", stagingFile]);
  if (!existsSync(stagingFile)) {
    throw new Error("TypeScript client generation did not produce clients/ts/src/schema.d.ts");
  }
  replaceFileFromStaging(stagingFile, outputFile);
} finally {
  rmSync(stagingDir, { recursive: true, force: true });
}
