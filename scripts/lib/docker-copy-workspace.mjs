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
  inputs,
  outputs = [],
  stagingRoot,
  workingDirectory,
  containerName = `mnt-openapi-codegen-${randomUUID()}`,
  spawn = spawnSync,
  ...unsupportedOptions
}) {
  const unsupportedOptionNames = Object.keys(unsupportedOptions);
  if (unsupportedOptionNames.length > 0) {
    throw new Error(
      `Docker options are not supported by copied-workspace transport: ${unsupportedOptionNames.join(", ")}`,
    );
  }
  if (
    workingDirectory !== undefined &&
    (!/^\/workspace(?:\/[^=]*)?$/.test(workingDirectory) || workingDirectory.includes(".."))
  ) {
    throw new Error(
      `Docker working directory must be /workspace or a relative child: ${workingDirectory}`,
    );
  }

  requirePinnedImage(image);
  mkdirSync(stagingRoot, { recursive: true });
  const workspace = mkdtempSync(resolve(stagingRoot, "docker-workspace-"));
  let containerCreated = false;

  try {
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

      const createArgs = ["create", "--name", containerName];
      if (workingDirectory !== undefined) {
        createArgs.push("--workdir", workingDirectory);
      }
      createArgs.push(image, ...args);
      runDocker(spawn, createArgs);
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
    }
  } finally {
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
