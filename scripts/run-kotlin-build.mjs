import { chmodSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const projectDir = resolve(root, "clients/kotlin");
const gradlew = resolve(projectDir, process.platform === "win32" ? "gradlew.bat" : "gradlew");

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

if (spawnSync("java", ["-version"], { stdio: "ignore" }).status === 0) {
  if (process.platform !== "win32") {
    chmodSync(gradlew, 0o755);
  }
  if (process.platform === "win32") {
    run("cmd.exe", ["/c", gradlew, "build", "-x", "test"]);
  } else {
    run(gradlew, ["build", "-x", "test"]);
  }
} else {
  run("docker", [
    "run",
    "--rm",
    "-v",
    `${root}:/workspace`,
    "-w",
    "/workspace/clients/kotlin",
    "gradle:8.14.3-jdk21",
    "gradle",
    "build",
    "-x",
    "test",
  ]);
}
