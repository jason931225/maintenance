import { chmodSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDockerWithCopiedWorkspace } from "./lib/docker-copy-workspace.mjs";
import { hasJava, hasRunningDocker } from "./lib/toolchain-checks.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const projectDir = resolve(root, "clients/kotlin");
const gradlew = resolve(projectDir, process.platform === "win32" ? "gradlew.bat" : "gradlew");
const gradleImage =
  "gradle:8.14.3-jdk21@sha256:21bd311ed01360c189b8870c6b6e988199ff10f72d445d02fb39d3cff9da91d7";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectDir,
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`);
  }
}


if (!existsSync(gradlew)) {
  throw new Error("clients/kotlin/gradlew is missing; run npm run gen:api:kotlin first");
}

if (hasJava()) {
  if (process.platform !== "win32") {
    chmodSync(gradlew, 0o755);
  }
  if (process.platform === "win32") {
    run("cmd.exe", ["/c", gradlew, "build"]);
  } else {
    run(gradlew, ["build"]);
  }
} else {
  if (!hasRunningDocker()) {
    throw new Error(
      "Kotlin client build needs either a Java runtime for clients/kotlin/gradlew " +
        "or a running Docker daemon for the gradle:8.14.3-jdk21 fallback, and found neither.\n" +
        "  - Install a JDK (e.g. `brew install temurin`) so `java -version` works, or\n" +
        "  - start Docker/Colima so `docker info` succeeds, then re-run `npm run check:kotlin`.",
    );
  }
  runDockerWithCopiedWorkspace({
    image: gradleImage,
    dockerOptions: ["--workdir", "/workspace/clients/kotlin"],
    args: ["gradle", "build"],
    inputs: [{ source: projectDir, destination: "clients/kotlin" }],
    stagingRoot: resolve(root, ".cache/kotlin-build"),
  });
}
