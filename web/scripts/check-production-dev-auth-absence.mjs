import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, relative, join } from "node:path";

const FORBIDDEN_MARKERS = [
  "/api/v1/dev-auth/session",
  "__DEV_AUTH_LOCAL_ROLE_MENU__",
  "__DEV_AUTH_LOCAL_ROLE_COPY__",
  "__DEV_AUTH_KNL_PRESET_SENTINEL__",
  "다른 계정으로 전환",
];

async function artifactFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return artifactFiles(path);
      if (entry.isFile()) return [path];
      return [];
    }),
  );
  return nested.flat();
}

/** Returns one explicit violation per forbidden marker in a built artifact. */
export async function findForbiddenProductionArtifacts(distDirectory) {
  const root = resolve(distDirectory);
  const info = await stat(root);
  if (!info.isDirectory())
    throw new Error(
      `production artifact directory is not a directory: ${root}`,
    );
  const files = await artifactFiles(root);
  const violations = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const marker of FORBIDDEN_MARKERS) {
      if (content.includes(marker))
        violations.push(
          `${relative(root, file)} contains forbidden ${JSON.stringify(marker)}`,
        );
    }
  }
  return violations;
}

async function main() {
  const distDirectory =
    process.argv[2] ?? resolve(import.meta.dirname, "../dist");
  const violations = await findForbiddenProductionArtifacts(distDirectory);
  if (violations.length) {
    console.error("check-production-dev-auth-absence FAILED:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    "check-production-dev-auth-absence OK — production artifacts contain no local dev-auth endpoint, menu, copy, or presets.",
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  await main();
}
