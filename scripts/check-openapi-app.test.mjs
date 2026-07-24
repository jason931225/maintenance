import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const openApiGate = readFileSync(
  new URL("./check-openapi-app.mjs", import.meta.url),
  "utf8",
);
const contractRoundtrip = readFileSync(
  new URL("./contract-roundtrip.ts", import.meta.url),
  "utf8",
);

describe("OpenAPI app Buck2 gate", () => {
  it("builds the reusable app artifact with Buck2 and runs that artifact", () => {
    assert.match(openApiGate, /tools\/buck2/);
    assert.match(openApiGate, /"--out",\s*"\.tmp\/buck2\/api-contract\/mnt-app"/);
    assert.match(openApiGate, /"\/\/backend\/app:mnt-app"/);
    assert.match(openApiGate, /spawn\(appBinary, \[\]/);
    assert.doesNotMatch(openApiGate, /\bcargo\b/i);
  });

  it("keeps the Buck2 artifact as the contract roundtrip default", () => {
    assert.match(contractRoundtrip, /resolve\(root, "\.tmp\/buck2\/api-contract\/mnt-app"\)/);
    assert.doesNotMatch(contractRoundtrip, /backend\/target\/debug\/mnt-app/);
  });

  it("uses explicit app environments and bounded child shutdown", () => {
    assert.doesNotMatch(openApiGate, /\.\.\.process\.env/);
    assert.doesNotMatch(contractRoundtrip, /\.\.\.process\.env/);
    for (const source of [openApiGate, contractRoundtrip]) {
      assert.match(source, /observeChild\(spawn\(/);
      assert.match(source, /waitForChildReady\(/);
      assert.match(source, /await stopChild\(/);
    }
  });
});
