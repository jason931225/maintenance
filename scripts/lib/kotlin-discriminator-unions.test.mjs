import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  patchGeneratedKotlinMappedUnions,
  supportedWorkbenchUnionNames,
  validateSupportedKotlinDiscriminatorUnions,
} from "./kotlin-discriminator-unions.mjs";

const ref = (name) => `#/components/schemas/${name}`;

function child(discriminator, literal) {
  return {
    type: "object",
    required: [discriminator],
    properties: { [discriminator]: { type: "string", enum: [literal] } },
  };
}

function fixtureSchemas() {
  const schemas = new Map();
  const put = (name, schema) => schemas.set(name, schema);
  put("WorkbenchScopeAll", child("kind", "all"));
  put("WorkbenchScopeBranches", child("kind", "branches"));
  put("WorkbenchActionSourceOk", child("status", "ok"));
  put("WorkbenchTodoSourceOk", child("status", "ok"));
  put("WorkbenchCalendarSourceOk", child("status", "ok"));
  put("WorkbenchDeniedSourceEnvelope", child("status", "denied"));
  put("WorkbenchUnavailableSourceEnvelope", child("status", "unavailable"));
  put("ProductionDemandIngress", child("kind", "demand"));
  put("ProductionCapacityIngress", child("kind", "capacity"));
  put("ProductionMaterialIngress", child("kind", "material"));
  const union = (discriminator, mapping) => ({
    oneOf: Object.values(mapping).map((name) => ({ $ref: ref(name) })),
    discriminator: { propertyName: discriminator, mapping: Object.fromEntries(Object.entries(mapping).map(([literal, name]) => [literal, ref(name)])) },
  });
  put("WorkbenchEffectiveScope", union("kind", { all: "WorkbenchScopeAll", branches: "WorkbenchScopeBranches" }));
  put("WorkbenchActionSourceEnvelope", union("status", { ok: "WorkbenchActionSourceOk", denied: "WorkbenchDeniedSourceEnvelope", unavailable: "WorkbenchUnavailableSourceEnvelope" }));
  put("WorkbenchTodoSourceEnvelope", union("status", { ok: "WorkbenchTodoSourceOk", denied: "WorkbenchDeniedSourceEnvelope", unavailable: "WorkbenchUnavailableSourceEnvelope" }));
  put("WorkbenchCalendarSourceEnvelope", union("status", { ok: "WorkbenchCalendarSourceOk", denied: "WorkbenchDeniedSourceEnvelope", unavailable: "WorkbenchUnavailableSourceEnvelope" }));
  put("ProductionSourceIngress", union("kind", { demand: "ProductionDemandIngress", capacity: "ProductionCapacityIngress", material: "ProductionMaterialIngress" }));
  return schemas;
}

function fixtureStaging(schemas) {
  const stagingDir = mkdtempSync(join(tmpdir(), "kotlin-union-"));
  const modelDir = join(stagingDir, "src/main/kotlin/com/maintenance/api/client/model");
  mkdirSync(modelDir, { recursive: true });
  for (const name of schemas.keys()) {
    if (name.includes("Envelope") || name === "WorkbenchEffectiveScope" || name.startsWith("WorkbenchScope") || name.endsWith("SourceOk") || name.startsWith("Production")) {
      writeFileSync(join(modelDir, `${name}.kt`), `package com.maintenance.api.client.model\n\n@kotlinx.serialization.Serializable\ndata class ${name} (\n) {\n}\n`);
    }
  }
  // This unmapped component is a non-target sentinel: generation must not touch it.
  writeFileSync(join(modelDir, "EvidenceHoldRequest.kt"), "unmapped inline oneOf remains unchanged\n");
  return stagingDir;
}

function digestTree(stagingDir, names) {
  return createHash("sha256").update(names.map((name) => readFileSync(join(stagingDir, "src/main/kotlin/com/maintenance/api/client/model", `${name}.kt`))).join("\0")).digest("hex");
}

test("strict Workbench union patch renders deterministic parents and patches shared children once", () => {
  const schemas = fixtureSchemas();
  const unions = validateSupportedKotlinDiscriminatorUnions(schemas);
  const first = fixtureStaging(schemas);
  const second = fixtureStaging(schemas);
  const firstResult = patchGeneratedKotlinMappedUnions({ stagingDir: first, unions });
  const secondResult = patchGeneratedKotlinMappedUnions({ stagingDir: second, unions: [...unions].reverse() });

  assert.equal(firstResult.unionCount, 5);
  assert.equal(firstResult.variantCount, 14);
  assert.deepEqual(
    { unionCount: firstResult.unionCount, variantCount: firstResult.variantCount },
    { unionCount: secondResult.unionCount, variantCount: secondResult.variantCount },
  );
  const denied = readFileSync(join(first, "src/main/kotlin/com/maintenance/api/client/model/WorkbenchDeniedSourceEnvelope.kt"), "utf8");
  assert.match(denied, /:.*WorkbenchActionSourceEnvelope,\n    WorkbenchCalendarSourceEnvelope,\n    WorkbenchTodoSourceEnvelope/s);
  const parent = readFileSync(join(first, "src/main/kotlin/com/maintenance/api/client/model/WorkbenchActionSourceEnvelope.kt"), "utf8");
  assert.match(parent, /sealed interface WorkbenchActionSourceEnvelope/);
  assert.match(parent, /"ok" -> jsonDecoder\.json\.decodeFromJsonElement\(WorkbenchActionSourceOk\.serializer\(\), element\)/);
  assert.match(parent, /actualDiscriminator != expectedDiscriminator/);
  assert.equal(readFileSync(join(first, "src/main/kotlin/com/maintenance/api/client/model/EvidenceHoldRequest.kt"), "utf8"), "unmapped inline oneOf remains unchanged\n");
  assert.equal(digestTree(first, [...supportedWorkbenchUnionNames, "WorkbenchActionSourceOk", "WorkbenchTodoSourceOk", "WorkbenchCalendarSourceOk", "WorkbenchDeniedSourceEnvelope", "WorkbenchUnavailableSourceEnvelope", "WorkbenchScopeAll", "WorkbenchScopeBranches", "ProductionDemandIngress", "ProductionCapacityIngress", "ProductionMaterialIngress"]), digestTree(second, [...supportedWorkbenchUnionNames, "WorkbenchActionSourceOk", "WorkbenchTodoSourceOk", "WorkbenchCalendarSourceOk", "WorkbenchDeniedSourceEnvelope", "WorkbenchUnavailableSourceEnvelope", "WorkbenchScopeAll", "WorkbenchScopeBranches", "ProductionDemandIngress", "ProductionCapacityIngress", "ProductionMaterialIngress"]));
});

test("strict union validation rejects mapping mismatch, ambiguous targets, and incorrect discriminator literal", () => {
  const mismatch = fixtureSchemas();
  mismatch.get("WorkbenchActionSourceEnvelope").oneOf.pop();
  assert.throws(() => validateSupportedKotlinDiscriminatorUnions(mismatch), /oneOf refs and discriminator\.mapping refs/);

  const ambiguous = fixtureSchemas();
  ambiguous.get("WorkbenchActionSourceEnvelope").discriminator.mapping.denied = ref("WorkbenchUnavailableSourceEnvelope");
  assert.throws(() => validateSupportedKotlinDiscriminatorUnions(ambiguous), /must not map multiple literals to one target/);

  const wrong = fixtureSchemas();
  wrong.get("WorkbenchTodoSourceOk").properties.status.enum = ["not-ok"];
  assert.throws(() => validateSupportedKotlinDiscriminatorUnions(wrong), /maps "ok" to WorkbenchTodoSourceOk/);

  const missingMapping = fixtureSchemas();
  delete missingMapping.get("WorkbenchEffectiveScope").discriminator.mapping;
  assert.throws(() => validateSupportedKotlinDiscriminatorUnions(missingMapping), /mapping must be an object/);

  const missingProperty = fixtureSchemas();
  delete missingProperty.get("WorkbenchScopeAll").properties.kind;
  assert.throws(() => validateSupportedKotlinDiscriminatorUnions(missingProperty), /WorkbenchScopeAll\.kind must be an object/);

  const externalRef = fixtureSchemas();
  externalRef.get("WorkbenchActionSourceEnvelope").oneOf[0].$ref = "https://example.invalid/Other";
  assert.throws(() => validateSupportedKotlinDiscriminatorUnions(externalRef), /internal component schema ref/);
});

test("strict patch fails before write when generated model files or declarations drift", () => {
  const schemas = fixtureSchemas();
  const unions = validateSupportedKotlinDiscriminatorUnions(schemas);
  const staging = fixtureStaging(schemas);
  const broken = join(staging, "src/main/kotlin/com/maintenance/api/client/model/WorkbenchScopeBranches.kt");
  writeFileSync(broken, "package com.maintenance.api.client.model\n");
  const untouchedParent = join(staging, "src/main/kotlin/com/maintenance/api/client/model/WorkbenchActionSourceEnvelope.kt");
  const before = readFileSync(untouchedParent, "utf8");
  assert.throws(() => patchGeneratedKotlinMappedUnions({ stagingDir: staging, unions }), /concrete data-class declaration/);
  assert.equal(readFileSync(untouchedParent, "utf8"), before, "validation failure must not partially rewrite parent files");

  const missingStaging = fixtureStaging(schemas);
  rmSync(join(missingStaging, "src/main/kotlin/com/maintenance/api/client/model/WorkbenchScopeBranches.kt"));
  assert.throws(() => patchGeneratedKotlinMappedUnions({ stagingDir: missingStaging, unions }), /generated child WorkbenchScopeBranches is missing/);
});
