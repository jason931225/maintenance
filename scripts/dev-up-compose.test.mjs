#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const compose = readFileSync(new URL("../ops/compose.dev-deps.yml", import.meta.url), "utf8");

test("mox localserve creates its config below the named volume root", () => {
  assert.match(compose, /localserve/);

  const dataDir = compose.match(/-dir[",\s]+(?<dir>\/mox-data\/[^"\s]+)/)?.groups?.dir;
  assert.ok(dataDir, "mox localserve command should pass a child -dir under /mox-data");

  const volumeTarget = compose.match(/^\s*-\s*mox-data:(?<target>\/\S+)/m)?.groups?.target;
  assert.ok(volumeTarget, "mox service should mount the mox-data volume");

  assert.notEqual(
    dataDir,
    volumeTarget,
    "mox localserve must not point -dir at the mounted volume root; Docker creates that directory before mox starts, so localserve tries to load a missing config instead of generating one",
  );
  assert.ok(
    dataDir.startsWith(`${volumeTarget}/`),
    `mox localserve data dir ${dataDir} should stay inside named volume ${volumeTarget}`,
  );
  assert.match(
    compose,
    new RegExp(`${dataDir.replaceAll("/", "\\/")}\\/mox\\.conf`),
    "mox localserve should branch on the generated config file before reusing a persistent named volume",
  );
  assert.match(
    compose,
    new RegExp(`localserve -dir ${dataDir.replaceAll("/", "\\/")}`),
    "restarts with an existing config must omit -ip because mox only accepts -ip while creating a new config",
  );
});
