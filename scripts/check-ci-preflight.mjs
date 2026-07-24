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

const apiContractCaptureName = "Capture Buck2-built app for contract test";
const apiContractCaptureCommands = [
  "set -euo pipefail",
  'mnt_app_bin="${GITHUB_WORKSPACE}/.tmp/buck2/api-contract/mnt-app"',
  'test -x "${mnt_app_bin}"',
  "printf 'MNT_APP_BIN=%s\\n' \"${mnt_app_bin}\" >> \"${GITHUB_ENV}\"",
];
const apiContractAllowedSteps = [
  "name: Checkout\n        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7",
  "name: Install pinned DotSlash runtime\n        run: tools/buck/install_dotslash.sh",
  "name: Free runner disk for API contract\n        uses: ./.github/actions/free-runner-disk",
  "name: Install Rust toolchain (pinned via rust-toolchain.toml)\n        uses: dtolnay/rust-toolchain@29eef336d9b2848a0b548edc03f92a220660cdb8 # stable\n        with:\n          toolchain: \"1.96.0\"",
  "name: Cache Rust dependencies + build artifacts\n        uses: Swatinem/rust-cache@c19371144df3bb44fab255c43d04cbc2ab54d1c4 # v2.9.1\n        with:\n          workspaces: backend",
  "name: Set up Node.js\n        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0\n        with:\n          node-version: \"24\"\n          cache: npm",
  "name: Install client tooling\n        run: npm ci",
  "name: OpenAPI app-served drift gate\n        if: ${{ !cancelled() }}\n        run: npm run check:openapi-app",
  `name: ${apiContractCaptureName}
        if: \${{ !cancelled() }}
        shell: bash
        run: |
          set -euo pipefail
          # check:openapi-app is the sole Buck2 producer for this handoff.
          mnt_app_bin="\${GITHUB_WORKSPACE}/.tmp/buck2/api-contract/mnt-app"
          test -x "\${mnt_app_bin}"
          printf 'MNT_APP_BIN=%s\\n' "\${mnt_app_bin}" >> "\${GITHUB_ENV}"`,
  "name: Employee import replay contract\n        if: ${{ !cancelled() }}\n        run: npm run test:employee-import-contract",
  "name: Ontology write precondition contract\n        if: ${{ !cancelled() }}\n        run: npm run test:ontology-write-precondition",
  "name: Generated TypeScript client round-trip\n        if: ${{ !cancelled() }}\n        run: npm run test:contract",
];

function hasOnlyAllowedApiContractSteps(steps) {
  return steps.length === apiContractAllowedSteps.length
    && steps.every((step, index) => step.trimEnd() === apiContractAllowedSteps[index]);
}

function isDesignatedApiContractCapture(step) {
  if (!step.startsWith(`name: ${apiContractCaptureName}\n`)) return false;
  return multilineRunCommands(step).filter((line) => !line.startsWith("#")).join("\n")
    === apiContractCaptureCommands.join("\n");
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

function requireEffectiveDotSlashBootstrap(block, job, failures) {
  const workingDirectory = block.match(/^    defaults:\n      run:\n        working-directory: ([^\n]+)$/m)?.[1]?.trim();
  const bootstrap = workingDirectory === "backend" ? `../${dotSlashBootstrap}` : dotSlashBootstrap;
  const steps = stepBlocks(block);
  const bootstrapIndex = steps.findIndex((step) => runScalar(step) === bootstrap);
  if (bootstrapIndex < 0) {
    failures.push(`${job} must install pinned DotSlash from ${bootstrap}`);
    return;
  }
  const firstBuckInvocation = steps.findIndex((step, index) => {
    const run = runScalar(step);
    const command = run === "|" ? multilineRunCommands(step).join("\n") : run ?? "";
    return index !== bootstrapIndex
      && (/(?:^|[^A-Za-z0-9_])tools\/buck(?:2|\/)/.test(command) || /\bdotslash\b/i.test(command));
  });
  if (firstBuckInvocation >= 0 && bootstrapIndex > firstBuckInvocation) {
    failures.push(`${job} must install pinned DotSlash before its first Buck invocation`);
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
    const apiContractSteps = stepBlocks(apiContract);
    if (!hasOnlyAllowedApiContractSteps(apiContractSteps)) {
      failures.push("api-contract must contain only the approved ordered steps");
    }
    requireDotSlashBefore(
      apiContractSteps,
      "npm run check:openapi-app",
      "api-contract",
      failures,
    );
    const openApiGateIndexes = apiContractSteps
      .map((step, index) => (runScalar(step) === "npm run check:openapi-app" ? index : -1))
      .filter((index) => index >= 0);
    if (openApiGateIndexes.length !== 1) {
      failures.push("api-contract must run exactly one npm run check:openapi-app producer");
    }
    const jobOrStepAppBinaryOverride = /^ {6,}MNT_APP_BIN\s*:/m.test(apiContract);
    const captureStepIndexes = apiContractSteps
      .map((step, index) => (step.startsWith(`name: ${apiContractCaptureName}\n`) ? index : -1))
      .filter((index) => index >= 0);
    const captureStepIndex = captureStepIndexes[0] ?? -1;
    const captureIsDesignated = captureStepIndexes.length === 1 && isDesignatedApiContractCapture(apiContractSteps[captureStepIndex]);
    const nonCaptureSteps = apiContractSteps.filter((_, index) => index !== captureStepIndex);
    const shellAppBinaryOverride = nonCaptureSteps.some((step) => step.includes("MNT_APP_BIN"));
    const cargoTargetAppBinaryOverride = apiContract.split(/\r?\n/).some((line) =>
      !line.trimStart().startsWith("#") && line.includes("MNT_APP_BIN:") && (line.includes("backend/target") || line.includes("CARGO_TARGET_DIR")),
    );
    if (jobOrStepAppBinaryOverride || shellAppBinaryOverride) {
      failures.push("api-contract must not override the captured MNT_APP_BIN");
    }
    if (cargoTargetAppBinaryOverride) {
      failures.push("api-contract must not use a Cargo target path for MNT_APP_BIN");
    }
    if (!captureIsDesignated) {
      failures.push("api-contract capture must use the designated verified command grammar");
    }
    if (nonCaptureSteps.some((step) => step.includes("GITHUB_ENV"))) {
      failures.push("api-contract may reference GITHUB_ENV only in the designated capture step");
    }

    const openApiGateIndex = openApiGateIndexes[0] ?? -1;
    const contractTestIndex = apiContractSteps.findIndex((step) => runScalar(step) === "npm run test:contract");
    if (
      openApiGateIndex < 0
      || contractTestIndex < 0
      || captureStepIndex < openApiGateIndex
      || captureStepIndex > contractTestIndex
    ) {
      failures.push("api-contract must capture the Buck2-built mnt-app path for npm run test:contract");
    }
  }

  const backend = jobBlock(workflow, "backend");
  if (backend) requireEffectiveDotSlashBootstrap(backend, "backend", failures);

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
