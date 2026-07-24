import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findForbiddenProductionArtifacts } from "./check-production-dev-auth-absence.mjs";

async function withDist(files, run) {
  const dir = await mkdtemp(join(tmpdir(), "mnt-production-dev-auth-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const path = join(dir, name);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, content);
    }
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("accepts a production artifact without local dev-auth markers", async () => {
  await withDist({ "assets/app.js": "console.log('release')" }, async (dir) => {
    assert.deepEqual(await findForbiddenProductionArtifacts(dir), []);
  });
});

test("rejects every endpoint, menu, copy, and preset marker that reaches a production artifact", async () => {
  await withDist(
    {
      "assets/app.js": [
        "/api/v1/dev-auth/session",
        "__DEV_AUTH_LOCAL_ROLE_MENU__",
        "__DEV_AUTH_LOCAL_ROLE_COPY__",
        "__DEV_AUTH_KNL_PRESET_SENTINEL__",
        "다른 계정으로 전환",
      ].join(" "),
    },
    async (dir) => {
      const violations = await findForbiddenProductionArtifacts(dir);
      assert.equal(violations.length, 5);
      for (const marker of [
        "dev-auth/session",
        "LOCAL_ROLE_MENU",
        "LOCAL_ROLE_COPY",
        "KNL_PRESET_SENTINEL",
        "다른 계정으로 전환",
      ]) {
        assert.match(violations.join("\n"), new RegExp(marker));
      }
    },
  );
});
