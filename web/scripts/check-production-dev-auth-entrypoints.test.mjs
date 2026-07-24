import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("CI and Docker production entrypoints execute the non-recursive dev-auth artifact gate", async () => {
  const [rootPackage, webPackage, ci, dockerfile] = await Promise.all([
    readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    readFile(resolve(repositoryRoot, "web/package.json"), "utf8"),
    readFile(resolve(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
    readFile(resolve(repositoryRoot, "web/Dockerfile"), "utf8"),
  ]);
  const rootScripts = JSON.parse(rootPackage).scripts;
  const webScripts = JSON.parse(webPackage).scripts;
  const gate = "check:production-dev-auth-absence";

  assert.equal(
    rootScripts["check:web-production-dev-auth-absence"],
    `npm --workspace web run ${gate}`,
  );
  assert.equal(
    webScripts[gate],
    "npm run build && node scripts/check-production-dev-auth-absence.mjs",
  );
  assert.doesNotMatch(webScripts.build, new RegExp(gate));
  assert.match(
    ci,
    /run: npm run check:production-dev-auth-absence --workspace @console\/web/,
  );
  assert.match(
    dockerfile,
    /RUN npm run check:production-dev-auth-absence --workspace @console\/web/,
  );
});
