import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  runDockerCodegenWithCopiedWorkspace,
  runDockerWithCopiedWorkspace,
} from "./docker-copy-workspace.mjs";

function makeFixture(t) {
  const root = resolve(tmpdir(), `docker-copy-workspace-${process.pid}-${Date.now()}`);
  const stagingRoot = resolve(root, "staging");
  const outputDir = resolve(root, "output");
  const spec = resolve(root, "source/openapi.yaml");
  const config = resolve(root, "source/config.yaml");
  const templates = resolve(root, "source/templates");

  mkdirSync(templates, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(spec, "openapi: 3.0.3\n", "utf8");
  writeFileSync(config, "artifactId: maintenance-api-client\n", "utf8");
  writeFileSync(resolve(templates, "ApiClient.mustache"), "template\n", "utf8");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  return { config, outputDir, spec, stagingRoot, templates };
}

test("copies an exact workspace into Docker instead of bind-mounting the host path", (t) => {
  const fixture = makeFixture(t);
  const calls = [];

  const spawn = (command, args) => {
    calls.push([command, args]);
    if (args[0] === "cp" && args[2] === "test-container:/workspace") {
      const copiedWorkspace = args[1];
      assert.equal(
        "openapi: 3.0.3\n",
        readFileSync(
          resolve(copiedWorkspace, "backend/openapi/openapi.yaml"),
          "utf8",
        ),
      );
      assert.equal(
        "artifactId: maintenance-api-client\n",
        readFileSync(
          resolve(copiedWorkspace, "clients/kotlin-generator-config.yaml"),
          "utf8",
        ),
      );
      assert.equal(
        "template\n",
        readFileSync(
          resolve(
            copiedWorkspace,
            "clients/kotlin-generator-templates/ApiClient.mustache",
          ),
          "utf8",
        ),
      );
    }
    if (
      args[0] === "cp" &&
      args[1] === "test-container:/workspace/generated/."
    ) {
      writeFileSync(resolve(args[2], "build.gradle"), "generated\n", "utf8");
    }
    return { status: 0 };
  };

  runDockerCodegenWithCopiedWorkspace({
    image: `example.invalid/codegen:v1@sha256:${"a".repeat(64)}`,
    args: ["generate", "-o", "/workspace/generated"],
    inputs: [
      {
        source: fixture.spec,
        destination: "backend/openapi/openapi.yaml",
      },
      {
        source: fixture.config,
        destination: "clients/kotlin-generator-config.yaml",
      },
      {
        source: fixture.templates,
        destination: "clients/kotlin-generator-templates",
      },
    ],
    outputDir: fixture.outputDir,
    stagingRoot: fixture.stagingRoot,
    containerName: "test-container",
    spawn,
  });

  assert.equal(
    "generated\n",
    readFileSync(resolve(fixture.outputDir, "build.gradle"), "utf8"),
  );
  assert.deepEqual(
    calls.map(([, args]) => args[0]),
    ["create", "cp", "start", "cp", "rm"],
  );
  assert.equal(
    calls.some(([, args]) => args.includes("-v") || args[0] === "run"),
    false,
  );
  assert.equal(existsSync(calls[1][1][1]), false);
});

test("removes the disposable container and copied workspace after generator failure", (t) => {
  const fixture = makeFixture(t);
  const calls = [];

  const spawn = (command, args) => {
    calls.push([command, args]);
    return { status: args[0] === "start" ? 17 : 0 };
  };

  assert.throws(
    () =>
      runDockerCodegenWithCopiedWorkspace({
        image: `example.invalid/codegen:v1@sha256:${"a".repeat(64)}`,
        args: ["generate", "-o", "/workspace/generated"],
        inputs: [
          {
            source: fixture.spec,
            destination: "backend/openapi/openapi.yaml",
          },
        ],
        outputDir: fixture.outputDir,
        stagingRoot: fixture.stagingRoot,
        containerName: "test-container",
        spawn,
      }),
    /docker start --attach test-container failed with exit 17/,
  );

  assert.deepEqual(
    calls.map(([, args]) => args[0]),
    ["create", "cp", "start", "rm"],
  );
  assert.equal(existsSync(calls[1][1][1]), false);
});

test("fails closed when disposable container cleanup fails", (t) => {
  const fixture = makeFixture(t);
  let copiedWorkspace;

  assert.throws(
    () =>
      runDockerWithCopiedWorkspace({
        image: `example.invalid/codegen:v1@sha256:${"c".repeat(64)}`,
        args: ["generate"],
        inputs: [{ source: fixture.spec, destination: "backend/openapi/openapi.yaml" }],
        stagingRoot: fixture.stagingRoot,
        containerName: "test-container",
        spawn(_command, args) {
          if (args[0] === "cp" && args[2] === "test-container:/workspace") {
            copiedWorkspace = args[1];
          }
          return { status: args[0] === "rm" ? 23 : 0 };
        },
      }),
    /docker rm -f test-container failed with exit 23/,
  );
  assert.equal(existsSync(copiedWorkspace), false);
  assert.deepEqual(
    readdirSync(fixture.stagingRoot).filter((entry) => entry.startsWith("docker-workspace-")),
    [],
  );
});

test("rejects Docker flag passthrough, including equals-form variants", (t) => {
  const fixture = makeFixture(t);
  const forbiddenOptions = [
    ["dockerOptions", ["--volume=/host:/workspace"]],
    ["bind", "--bind=/host:/workspace"],
    ["mount", "--mount=type=bind,source=/host,target=/workspace"],
    ["network", "--network=host"],
    ["privileged", "--privileged=true"],
    ["device", "--device=/dev/fuse"],
    ["capAdd", "--cap-add=SYS_ADMIN"],
    ["secret", "--secret=id=token"],
  ];

  for (const [option, value] of forbiddenOptions) {
    assert.throws(
      () =>
        runDockerWithCopiedWorkspace({
          image: `example.invalid/codegen:v1@sha256:${"d".repeat(64)}`,
          args: ["generate"],
          inputs: [],
          stagingRoot: fixture.stagingRoot,
          [option]: value,
        }),
      new RegExp(`Docker options are not supported.*${option}`),
    );
  }
  assert.throws(
    () =>
      runDockerWithCopiedWorkspace({
        image: `example.invalid/codegen:v1@sha256:${"d".repeat(64)}`,
        args: ["generate"],
        inputs: [],
        stagingRoot: fixture.stagingRoot,
        workingDirectory: "--network=host",
      }),
    /Docker working directory must be \/workspace/,
  );
  assert.equal(existsSync(fixture.stagingRoot), false);
});

test("rejects an unpinned generator image before creating a workspace", (t) => {
  const fixture = makeFixture(t);

  assert.throws(
    () =>
      runDockerCodegenWithCopiedWorkspace({
        image: "example.invalid/codegen:v1",
        args: ["generate"],
        inputs: [],
        outputDir: fixture.outputDir,
        stagingRoot: fixture.stagingRoot,
      }),
    /must be pinned by sha256 digest/,
  );
  assert.equal(existsSync(fixture.stagingRoot), false);
});

test("runs a copied workspace command without bind mounts or host outputs", (t) => {
  const fixture = makeFixture(t);
  const calls = [];

  runDockerWithCopiedWorkspace({
    image: `example.invalid/gradle:v1@sha256:${"b".repeat(64)}`,
    workingDirectory: "/workspace/clients/kotlin",
    args: ["gradle", "build"],
    inputs: [{ source: fixture.templates, destination: "clients/kotlin" }],
    stagingRoot: fixture.stagingRoot,
    containerName: "test-container",
    spawn(command, args) {
      calls.push([command, args]);
      if (args[0] === "cp" && args[2] === "test-container:/workspace") {
        assert.equal(
          "template\n",
          readFileSync(
            resolve(calls.at(-1)[1][1], "clients/kotlin/ApiClient.mustache"),
            "utf8",
          ),
        );
      }
      return { status: 0 };
    },
  });

  assert.deepEqual(
    calls.map(([, args]) => args[0]),
    ["create", "cp", "start", "rm"],
  );
  assert.deepEqual(calls[0][1], [
    "create",
    "--name",
    "test-container",
    "--workdir",
    "/workspace/clients/kotlin",
    `example.invalid/gradle:v1@sha256:${"b".repeat(64)}`,
    "gradle",
    "build",
  ]);
  assert.equal(
    calls.some(([, args]) =>
      args.some((arg) => arg === "-v" || arg === "--privileged" || arg.startsWith("--network")),
    ),
    false,
  );
  assert.equal(existsSync(fixture.stagingRoot), true);
});
