import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function requirePinnedImage(image) {
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error(`Docker image must be pinned by sha256 digest: ${image}`);
  }
}

function workspaceDestination(workspace, destination) {
  const path = resolve(workspace, destination);
  const relativePath = relative(workspace, path);
  if (
    !destination ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    resolve(destination) === destination
  ) {
    throw new Error(`Docker workspace destination must be relative: ${destination}`);
  }
  return path;
}

function runDocker(spawn, args, options = {}) {
  const result = spawn("docker", args, {
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) {
    const cause = result.error ? `: ${result.error.message}` : "";
    throw new Error(`docker ${args.join(" ")} failed with exit ${result.status}${cause}`);
  }
}

export function runDockerWithCopiedWorkspace({
  image,
  args,
  dockerOptions = [],
  inputs,
  outputs = [],
  stagingRoot,
  containerName = `mnt-openapi-codegen-${randomUUID()}`,
  spawn = spawnSync,
}) {
  requirePinnedImage(image);
  mkdirSync(stagingRoot, { recursive: true });
  const workspace = mkdtempSync(resolve(stagingRoot, "docker-workspace-"));
  let containerCreated = false;

  try {
    for (const { source, destination } of inputs) {
      if (!existsSync(source)) {
        throw new Error(`Docker workspace input is absent: ${source}`);
      }
      const target = workspaceDestination(workspace, destination);
      mkdirSync(resolve(target, ".."), { recursive: true });
      cpSync(source, target, { recursive: true, force: true });
    }

    for (const { destination } of outputs) {
      mkdirSync(destination, { recursive: true });
    }

    runDocker(spawn, [
      "create",
      "--name",
      containerName,
      ...dockerOptions,
      image,
      ...args,
    ]);
    containerCreated = true;
    runDocker(spawn, ["cp", `${workspace}/.`, `${containerName}:/workspace`]);
    runDocker(spawn, ["start", "--attach", containerName]);
    for (const { source, destination } of outputs) {
      runDocker(spawn, ["cp", `${containerName}:${source}/.`, destination]);
    }
  } finally {
    if (containerCreated) {
      runDocker(spawn, ["rm", "-f", containerName], { stdio: "ignore" });
    }
    rmSync(workspace, { recursive: true, force: true });
  }
}

export function runDockerCodegenWithCopiedWorkspace({
  outputDir,
  ...options
}) {
  return runDockerWithCopiedWorkspace({
    ...options,
    outputs: [{ source: "/workspace/generated", destination: outputDir }],
  });
}
