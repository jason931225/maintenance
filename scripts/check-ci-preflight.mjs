#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dotSlashBootstrap = "tools/buck/install_dotslash.sh";
const reindeerToolchainLock = "third-party/rust/reindeer/upstream.lock";
const reindeerToolchainSource = `source ${reindeerToolchainLock}`;
const reindeerToolchainInstall = 'rustup toolchain install "$REINDEER_TOOLCHAIN" --profile minimal';
const strictShellMode = "set -euo pipefail";
const reindeerToolchainOverride = /^(?:export\s+)?REINDEER_TOOLCHAIN\s*=/;
const requiredPreflightCommands = [
  "tools/buck/preflight.sh",
  "npm run check:foundation-gates",
  "npm run check:ci-preflight",
  "npm run check:root-workspaces",
  "npm run test:root-workspaces",
  "npm run check:package-lock",
];
const protectedJobs = [
  "backend",
  "dev-up-smoke",
  "api-clients",
  "web",
  "api-contract",
  "kubernetes-manifests",
  "swift-client",
  "mobile-parity",
  "android-app",
  "android-instrumented",
  "ios-app",
  "browser-e2e",
  "generated-face-authority",
];

function triggerPathEntries(workflow, trigger) {
  const match = workflow.match(new RegExp(`^  ${trigger}:\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:|^permissions:)`, "m"));
  const paths = match?.[1].match(/^    paths:\n((?:      - "[^"]+"\n)+)/m);
  return paths ? [...paths[1].matchAll(/^      - "([^"]+)"$/gm)].map((entry) => entry[1]) : [];
}

function jobBlock(workflow, job) {
  const jobs = workflow.slice(workflow.indexOf("jobs:\n") + "jobs:\n".length);
  const match = jobs.match(new RegExp(`^  ${job}:\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:|(?![\\s\\S]))`, "m"));
  return match?.[1] ?? null;
}

function needsPreflight(block) {
  const value = block.match(/^    needs:\s*(.+)$/m)?.[1]?.trim();
  if (!value) return false;
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1).split(",").map((job) => job.trim()).includes("preflight");
  }
  return value === "preflight";
}

function stepBlocks(block) {
  const steps = block.match(/^    steps:\n([\s\S]*)$/m)?.[1] ?? "";
  return steps.split(/^      - /m).slice(1);
}

function runScalar(step) {
  return step.match(/^        run: ([^\n]+)$/m)?.[1]?.trim();
}

function isUnconditional(step) {
  return !/^        (?:if|continue-on-error):/m.test(step);
}

function multilineRunCommands(step) {
  const run = step.match(/^        run: \|\n((?:          [^\n]*(?:\n|$))*)/m)?.[1] ?? "";
  return run
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function requireReindeerToolchainBefore(steps, command, failures) {
  const commandIndex = steps.findIndex((step) => runScalar(step) === command);
  const toolchainIndex = steps.findIndex((step) => multilineRunCommands(step).includes(reindeerToolchainInstall));
  if (toolchainIndex < 0) {
    failures.push("generated-face-authority must install the lock-pinned Reindeer Rust toolchain before full generated-face closure");
    return;
  }
  const commands = multilineRunCommands(steps[toolchainIndex]);
  const strictModeIndex = commands.indexOf(strictShellMode);
  const sourceIndex = commands.indexOf(reindeerToolchainSource);
  const installIndex = commands.indexOf(reindeerToolchainInstall);
  if (sourceIndex < 0) {
    failures.push(`generated-face-authority must source ${reindeerToolchainLock} before installing the Reindeer Rust toolchain`);
  } else if (strictModeIndex < 0 || strictModeIndex > sourceIndex) {
    failures.push(`generated-face-authority must enable strict shell mode before sourcing ${reindeerToolchainLock}`);
  } else if (sourceIndex > installIndex) {
    failures.push(`generated-face-authority must source ${reindeerToolchainLock} before installing the Reindeer Rust toolchain`);
  }
  if (commands.some((entry) => reindeerToolchainOverride.test(entry))) {
    failures.push(`generated-face-authority must not override REINDEER_TOOLCHAIN after sourcing ${reindeerToolchainLock}`);
  }
  if (!isUnconditional(steps[toolchainIndex])) {
    failures.push("generated-face-authority must install the Reindeer Rust toolchain unconditionally");
  }
  if (commandIndex >= 0 && toolchainIndex > commandIndex) {
    failures.push("generated-face-authority must install the lock-pinned Reindeer Rust toolchain before full generated-face closure");
  }
}

function requireDotSlashBefore(steps, command, job, failures) {
  const commandIndex = steps.findIndex((step) => runScalar(step) === command);
  const dotSlashIndex = steps.findIndex((step) => runScalar(step) === dotSlashBootstrap);
  if (dotSlashIndex < 0) {
    failures.push(`${job} must install pinned DotSlash before Buck2`);
  } else if (!isUnconditional(steps[dotSlashIndex])) {
    failures.push(`${job} must install DotSlash unconditionally`);
  } else if (commandIndex >= 0 && dotSlashIndex > commandIndex) {
    failures.push(`${job} must install DotSlash before ${command}`);
  }
}

export function evaluateCiPreflight(workflow) {
  const failures = [];
  for (const trigger of ["push", "pull_request"]) {
    if (!triggerPathEntries(workflow, trigger).includes("toolchains/**")) {
      failures.push(`${trigger} must include toolchains/** in CI path filters`);
    }
  }

  const preflight = jobBlock(workflow, "preflight");
  if (!preflight) {
    failures.push("CI must define a preflight job before expensive jobs");
    return { failures };
  }

  const preflightSteps = stepBlocks(preflight);
  requireDotSlashBefore(preflightSteps, "tools/buck/preflight.sh", "preflight", failures);
  for (const command of requiredPreflightCommands) {
    const matchingSteps = preflightSteps.filter((step) => runScalar(step) === command);
    if (matchingSteps.length === 0) {
      failures.push(`preflight must run ${command}`);
    } else if (matchingSteps.some((step) => !isUnconditional(step))) {
      failures.push(`preflight must run ${command} unconditionally without if or continue-on-error`);
    }
  }

  const fullGeneratedFaces = jobBlock(workflow, "generated-face-authority");
  if (fullGeneratedFaces) {
    const fullGeneratedFaceSteps = stepBlocks(fullGeneratedFaces);
    const fullGeneratedFaceCommand = "tools/buck/preflight.sh --full-generated-faces";
    const matchingFullGateSteps = fullGeneratedFaceSteps.filter((step) => runScalar(step) === fullGeneratedFaceCommand);
    if (matchingFullGateSteps.length === 0) {
      failures.push("generated-face-authority must run the complete generated-face closure");
    } else if (matchingFullGateSteps.some((step) => !isUnconditional(step))) {
      failures.push("generated-face-authority must run the complete generated-face closure unconditionally");
    }
    requireDotSlashBefore(
      fullGeneratedFaceSteps,
      fullGeneratedFaceCommand,
      "generated-face-authority",
      failures,
    );
    requireReindeerToolchainBefore(fullGeneratedFaceSteps, fullGeneratedFaceCommand, failures);
  }

  const apiContract = jobBlock(workflow, "api-contract");
  if (apiContract) {
    requireDotSlashBefore(
      stepBlocks(apiContract),
      "npm run check:openapi-app",
      "api-contract",
      failures,
    );
  }

  for (const job of protectedJobs) {
    const block = jobBlock(workflow, job);
    if (!block) {
      failures.push(`CI must define protected job ${job}`);
    } else if (!needsPreflight(block)) {
      failures.push(`${job} must need preflight`);
    } else if (/^    if:/m.test(block)) {
      failures.push(`${job} must not define job-level if`);
    }
  }

  return { failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { failures } = evaluateCiPreflight(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8"));
  if (failures.length > 0) {
    console.error("CI preflight contract failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log("CI preflight contract passed.");
}
