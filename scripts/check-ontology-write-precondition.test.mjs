import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const openapi = readFileSync(
  new URL("../backend/openapi/openapi.yaml", import.meta.url),
  "utf8",
);
const generatedTs = readFileSync(
  new URL("../clients/ts/src/schema.d.ts", import.meta.url),
  "utf8",
);
const ciWorkflow = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);

function stageOperation(spec) {
  const start = spec.indexOf("  /api/v1/ontology/object-types/{key}:");
  const put = spec.indexOf("    put:", start);
  const nextPath = spec.indexOf("\n  /api/", put);
  assert.notEqual(start, -1);
  assert.notEqual(put, -1);
  return spec.slice(put, nextPath);
}

test("ontology stage declares strong required If-Match and exact precondition statuses", () => {
  const operation = stageOperation(openapi);
  assert.match(operation, /name: If-Match[\s\S]*in: header[\s\S]*required: true/);
  assert.match(operation, /'400':/);
  assert.match(operation, /'412':/);
  assert.match(operation, /'428':/);
  assert.match(operation, /headers:[\s\S]*ETag:/);
});

test("object type wire contract and regenerated TypeScript client carry key revision", () => {
  const summaryStart = openapi.indexOf("    ObjectTypeSummary:");
  const summaryEnd = openapi.indexOf("\n    InstanceLifecycleState:", summaryStart);
  const summary = openapi.slice(summaryStart, summaryEnd);
  assert.match(summary, /required:[^\n]*key_write_revision/);
  assert.match(summary, /key_write_revision:/);
  assert.match(summary, /key_write_etag:/);
  assert.match(generatedTs, /key_write_revision: number/);
  assert.match(generatedTs, /key_write_etag: string/);
  assert.match(generatedTs, /"If-Match": string/);
});

test("hosted CI runs the ontology write precondition contract", () => {
  assert.match(
    ciWorkflow,
    /^\s*run:\s+npm run test:ontology-write-precondition\s*$/m,
  );
});
