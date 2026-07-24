import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { components, operations } from "../src/schema.js";

type JsonResponse<Operation, Status extends number> = Operation extends {
  responses: Record<Status, { content: { "application/json": infer Body } }>;
} ? Body : never;

type JsonRequest<Operation> = Operation extends {
  requestBody: { content: { "application/json": infer Body } };
} ? Body : never;

type Credential = components["schemas"]["ProductionSourceSystemCredential"];
type Receipt = components["schemas"]["ProductionSourceSystemReceipt"];
type IngressReceipt = components["schemas"]["ProductionSourceIngressReceipt"];
type Ingress = components["schemas"]["ProductionSourceIngress"];

const uuid = "00000000-0000-0000-0000-000000000001";

const registration = { branch_id: uuid, source_system: "erp" } satisfies JsonRequest<operations["registerProductionSourceSystem"]>;
const generation = { expected_generation: 1 } satisfies JsonRequest<operations["rotateProductionSourceSystem"]>;
const disabledGeneration = { expected_generation: 1 } satisfies JsonRequest<operations["disableProductionSourceSystem"]>;
void [registration, generation, disabledGeneration];

// The server creates the one-time secret; clients must never submit either the
// retired credential field or a principal id.
// @ts-expect-error registration accepts only branch_id and source_system.
const fabricatedRegistration: JsonRequest<operations["registerProductionSourceSystem"]> = { branch_id: uuid, source_system: "erp", credential: "forbidden" };
void fabricatedRegistration;

const demand = { kind: "demand", id: uuid, inquiry_id: uuid, product_code: "WIDGET", quantity: 1, due_at: "2026-07-23T12:00:00Z", source_id: "erp", source_version: "v1" } satisfies Ingress;
const capacity = { kind: "capacity", id: uuid, site_id: uuid, capacity_date: "2026-07-23", available_quantity: 1, source_id: "mes", source_version: "v1" } satisfies Ingress;
const material = { kind: "material", material_item_id: uuid, quantity_on_hand_milli: 1, safety_stock_milli: 0, source_id: "wms", source_version: "v1" } satisfies Ingress;
void [demand, capacity, material];

const credential: Credential = { id: uuid, source_system: "erp", enabled: true, credential_generation: 1, secret: "one-time-secret" };
const receipt: Receipt = { id: uuid, enabled: false, credential_generation: 2 };
const ingressReceipt: IngressReceipt = { kind: "demand", id: uuid, source_version: "v1" };

const typedRegister: JsonResponse<operations["registerProductionSourceSystem"], 201> = credential;
const typedRotate: JsonResponse<operations["rotateProductionSourceSystem"], 200> = credential;
const typedDisable: JsonResponse<operations["disableProductionSourceSystem"], 200> = receipt;
const typedIngress: JsonResponse<operations["ingestProductionSource"], 200> = ingressReceipt;
void [typedRegister, typedRotate, typedDisable, typedIngress];

function productionBlock(operationId: string, nextPath: string): string {
  const specification = readFileSync(fileURLToPath(new URL("../../../backend/openapi/openapi.yaml", import.meta.url)), "utf8");
  const start = specification.indexOf(`      operationId: ${operationId}\n`);
  assert.notEqual(start, -1, `OpenAPI operation ${operationId} must exist`);
  const end = specification.indexOf(nextPath, start);
  assert.notEqual(end, -1, `OpenAPI operation ${operationId} must have a bounded path block`);
  return specification.slice(start, end);
}

test("Production source-system contracts retain typed receipts, generations, and tagged ingress", () => {
  const ingress = productionBlock("ingestProductionSource", "  /api/v1/production/source-systems:\n");
  const register = productionBlock("registerProductionSourceSystem", "  /api/v1/production/source-systems/{source_system_id}/rotate:\n");
  const rotate = productionBlock("rotateProductionSourceSystem", "  /api/v1/production/source-systems/{source_system_id}/disable:\n");
  const disable = productionBlock("disableProductionSourceSystem", "  /api/v1/production/plans/{plan_id}:\n");

  assert.match(ingress, /summary: .+/);
  assert.match(ingress, /'200': \{description: .+, content: \{application\/json: \{schema: \{\$ref: '#\/components\/schemas\/ProductionSourceIngressReceipt'\}\}\}\}/);
  assert.match(register, /summary: .+/);
  assert.match(register, /'201': \{description: .+, content: \{application\/json: \{schema: \{\$ref: '#\/components\/schemas\/ProductionSourceSystemCredential'\}\}\}\}/);
  for (const operation of [rotate, disable]) {
    assert.match(operation, /summary: .+/);
    assert.match(operation, /requestBody: \{required: true, content: \{application\/json: \{schema: \{\$ref: '#\/components\/schemas\/ProductionSourceSystemGenerationRequest'\}\}\}\}/);
  }
  assert.match(rotate, /'200': \{description: .+, content: \{application\/json: \{schema: \{\$ref: '#\/components\/schemas\/ProductionSourceSystemCredential'\}\}\}\}/);
  assert.match(disable, /'200': \{description: .+, content: \{application\/json: \{schema: \{\$ref: '#\/components\/schemas\/ProductionSourceSystemReceipt'\}\}\}\}/);

  const schemas = readFileSync(fileURLToPath(new URL("../../../backend/openapi/openapi.yaml", import.meta.url)), "utf8").slice(
    readFileSync(fileURLToPath(new URL("../../../backend/openapi/openapi.yaml", import.meta.url)), "utf8").indexOf("    ProductionSourceIngress:\n"),
    readFileSync(fileURLToPath(new URL("../../../backend/openapi/openapi.yaml", import.meta.url)), "utf8").indexOf("    ProductionDemandIngress:\n"),
  );
  assert.match(schemas, /discriminator:\n\s+propertyName: kind\n\s+mapping:\n\s+demand: '#\/components\/schemas\/ProductionDemandIngress'\n\s+capacity: '#\/components\/schemas\/ProductionCapacityIngress'\n\s+material: '#\/components\/schemas\/ProductionMaterialIngress'/);
  assert.match(schemas, /required: \[branch_id, source_system\]/);
  assert.match(schemas, /Always true for a newly registered or rotated source system/);
  assert.match(schemas, /Always false after a source system is disabled/);
  assert.match(schemas, /secret: \{type: string, readOnly: true, description: One-time standard-base64 disclosure/);
  assert.doesNotMatch(schemas, /secret: \{[^\n]*writeOnly:/);
  assert.doesNotMatch(schemas, /\b(principal_id|credential|verifier|mac)\b/i);
  assert.doesNotMatch([ingress, register, rotate, disable, schemas].join("\n"), /\b(verifier|mac)\b/i);
  assert.doesNotMatch(schemas, /nullable:/);
});
