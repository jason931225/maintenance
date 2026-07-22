import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { evaluateRootWorkspaces } from "./check-root-workspaces.mjs";

function createRoot(workspaces) {
  const root = mkdtempSync(join(tmpdir(), "maintenance-root-workspaces-"));
  writeFileSync(root + "/package.json", JSON.stringify({ private: true, workspaces }));
  writeFileSync(root + "/package-lock.json", JSON.stringify({ packages: { "": { workspaces } } }));
  return root;
}

function addWorkspace(root, path) {
  mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, path, "package.json"), JSON.stringify({ name: `@test/${path}`, version: "0.0.0" }));
}

describe("root npm workspace integrity", () => {
  it("accepts every declared workspace directory with its package manifest", () => {
    const root = createRoot(["clients/ts", "web"]);
    addWorkspace(root, "clients/ts");
    addWorkspace(root, "web");

    assert.deepEqual(evaluateRootWorkspaces(root).failures, []);
  });

  it("fails closed when a declared workspace directory is absent", () => {
    const root = createRoot(["clients/ts", "retired-surface"]);
    addWorkspace(root, "clients/ts");

    assert.deepEqual(evaluateRootWorkspaces(root).failures, [
      'package.json workspace "retired-surface" must resolve to an existing directory',
    ]);
  });

  it("fails closed when a workspace lacks its package manifest", () => {
    const root = createRoot(["web"]);
    mkdirSync(join(root, "web"));

    assert.deepEqual(evaluateRootWorkspaces(root).failures, [
      'package.json workspace "web" must contain package.json',
    ]);
  });

  it("fails closed when a workspace is a symbolic link", () => {
    const root = createRoot(["web"]);
    addWorkspace(root, "outside");
    symlinkSync("outside", join(root, "web"));

    assert.deepEqual(evaluateRootWorkspaces(root).failures, [
      'package.json workspace "web" must not be a symbolic link',
    ]);
  });

  it("fails closed when a removed workspace remains in the lockfile package entry or link", () => {
    const root = createRoot(["clients/ts"]);
    addWorkspace(root, "clients/ts");
    writeFileSync(
      join(root, "package-lock.json"),
      JSON.stringify({
        packages: {
          "": { workspaces: ["clients/ts", "retired-surface"] },
          "clients/ts": { name: "@test/clients-ts", version: "0.0.0" },
          "retired-surface": { name: "@test/retired-surface", version: "0.0.0" },
          "node_modules/@test/retired-surface": { resolved: "retired-surface", link: true },
        },
      }),
    );

    assert.deepEqual(evaluateRootWorkspaces(root).failures, [
      "package-lock.json root workspaces must exactly match package.json workspaces",
      'package-lock.json contains stale workspace package entry "retired-surface"',
      'package-lock.json contains stale workspace link "node_modules/@test/retired-surface" -> "retired-surface"',
    ]);
  });
});
