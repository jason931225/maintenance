#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function isSafeWorkspacePath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.split(/[\\/]+/).includes("..") &&
    !/[*!?{}[\]]/.test(path)
  );
}

function readJson(root, path, failures) {
  try {
    return JSON.parse(readFileSync(resolve(root, path), "utf8"));
  } catch (error) {
    failures.push(`${path} must be valid JSON: ${error.message}`);
    return null;
  }
}

function checkLockfileWorkspaceTopology(packageJson, packageLock, failures) {
  const declaredWorkspaces = packageJson.workspaces;
  const packages = packageLock?.packages;
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) {
    failures.push("package-lock.json must contain a packages object");
    return;
  }

  const lockRootWorkspaces = packages[""]?.workspaces;
  if (!Array.isArray(lockRootWorkspaces)) {
    failures.push("package-lock.json root package must declare a workspaces array");
  } else if (JSON.stringify(lockRootWorkspaces) !== JSON.stringify(declaredWorkspaces)) {
    failures.push("package-lock.json root workspaces must exactly match package.json workspaces");
  }

  const declared = new Set(declaredWorkspaces);
  for (const [path, metadata] of Object.entries(packages)) {
    if (path === "") continue;

    if (!path.includes("node_modules/")) {
      if (!declared.has(path)) {
        failures.push(`package-lock.json contains stale workspace package entry ${JSON.stringify(path)}`);
      }
      continue;
    }

    if (metadata?.link === true && typeof metadata.resolved === "string" && !declared.has(metadata.resolved)) {
      failures.push(`package-lock.json contains stale workspace link ${JSON.stringify(path)} -> ${JSON.stringify(metadata.resolved)}`);
    }
  }
}

export function evaluateRootWorkspaces(root) {
  const failures = [];
  const packageJson = readJson(root, "package.json", failures);
  const packageLock = readJson(root, "package-lock.json", failures);
  if (!packageJson) return { failures };

  if (!Array.isArray(packageJson.workspaces) || packageJson.workspaces.length === 0) {
    failures.push("package.json must declare a non-empty workspaces array");
    return { failures };
  }

  for (const workspace of packageJson.workspaces) {
    if (!isSafeWorkspacePath(workspace)) {
      failures.push(`package.json workspace ${JSON.stringify(workspace)} must be a relative literal path without traversal or globs`);
      continue;
    }

    const workspaceDirectory = resolve(root, workspace);
    if (!existsSync(workspaceDirectory)) {
      failures.push(`package.json workspace ${JSON.stringify(workspace)} must resolve to an existing directory`);
      continue;
    }
    if (lstatSync(workspaceDirectory).isSymbolicLink()) {
      failures.push(`package.json workspace ${JSON.stringify(workspace)} must not be a symbolic link`);
      continue;
    }
    if (!statSync(workspaceDirectory).isDirectory()) {
      failures.push(`package.json workspace ${JSON.stringify(workspace)} must resolve to an existing directory`);
      continue;
    }
    if (!existsSync(resolve(workspaceDirectory, "package.json"))) {
      failures.push(`package.json workspace ${JSON.stringify(workspace)} must contain package.json`);
    }
  }

  if (packageLock) checkLockfileWorkspaceTopology(packageJson, packageLock, failures);

  return { failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { failures } = evaluateRootWorkspaces(root);

  if (failures.length > 0) {
    console.error("Root npm workspace integrity check failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log("Root npm workspace integrity check passed.");
}
