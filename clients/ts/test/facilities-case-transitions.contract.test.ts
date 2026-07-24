import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { components, operations } from "../src/schema.js";

type JsonSuccess<Operation> = Operation extends {
  responses: { 200: { content: { "application/json": infer Body } } };
}
  ? Body
  : never;

type JsonRequest<Operation> = Operation extends {
  requestBody: { content: { "application/json": infer Body } };
}
  ? Body
  : never;

type FacilitiesCase = components["schemas"]["FacilitiesCase"];

type TransitionOperation =
  | "triageFacilitiesCase"
  | "assignFacilitiesCase"
  | "startFacilitiesCase"
  | "submitFacilitiesExecution"
  | "decideFacilitiesAcceptance"
  | "recordFacilitiesObservation";

type TransitionSuccesses = {
  [Operation in TransitionOperation]: JsonSuccess<operations[Operation]>;
};

const facilitiesCase = {
  id: "00000000-0000-0000-0000-000000000001",
  status: "IN_PROGRESS",
  assigneeId: null,
  responseDueAt: "2026-07-23T12:00:00Z",
  completionDueAt: "2026-07-24T12:00:00Z",
  acceptanceDueAt: "2026-07-25T12:00:00Z",
  energyDeltaKwh: null,
  totalCostKrw: 0,
} satisfies FacilitiesCase;

// Compile-time regression: any success response regressing to void/no-content
// turns one of these assignments into an error.
const transitionSuccesses: TransitionSuccesses = {
  triageFacilitiesCase: facilitiesCase,
  assignFacilitiesCase: facilitiesCase,
  startFacilitiesCase: facilitiesCase,
  submitFacilitiesExecution: facilitiesCase,
  decideFacilitiesAcceptance: facilitiesCase,
  recordFacilitiesObservation: facilitiesCase,
};
void transitionSuccesses;

const triageRequest = {
  scheduledFor: "2026-07-23T12:00:00Z",
} satisfies JsonRequest<operations["triageFacilitiesCase"]>;
const assignRequest = {
  assigneeId: "00000000-0000-0000-0000-000000000002",
} satisfies JsonRequest<operations["assignFacilitiesCase"]>;
const submitRequest = {
  safetyChecklistEvidenceId: "00000000-0000-0000-0000-000000000003",
  serviceReportEvidenceId: "00000000-0000-0000-0000-000000000004",
} satisfies JsonRequest<operations["submitFacilitiesExecution"]>;
const acceptanceRequest = {
  decision: "ACCEPTED",
} satisfies JsonRequest<operations["decideFacilitiesAcceptance"]>;
const observationRequest = {
  observedAt: "2026-07-23T12:00:00Z",
} satisfies JsonRequest<operations["recordFacilitiesObservation"]>;
void [triageRequest, assignRequest, submitRequest, acceptanceRequest, observationRequest];

// Required request bodies must not become optional or untyped.
// @ts-expect-error Facilities triage requires a scheduledFor timestamp.
const missingTriageRequest: JsonRequest<operations["triageFacilitiesCase"]> = {};
void missingTriageRequest;

function facilitiesPath(operationId: string, nextPath?: string): string {
  const specification = readFileSync(
    fileURLToPath(new URL("../../../backend/openapi/openapi.yaml", import.meta.url)),
    "utf8",
  );
  const start = specification.indexOf(`      operationId: ${operationId}\n`);
  assert.notEqual(start, -1, `OpenAPI operation ${operationId} must exist`);
  const end = nextPath ? specification.indexOf(nextPath, start) : specification.indexOf("  /api/v1/logistics/asns:\n", start);
  assert.notEqual(end, -1, `OpenAPI operation ${operationId} must have a bounded path block`);
  return specification.slice(start, end);
}

test("Facilities transitions retain typed JSON case readbacks and required payloads", () => {
  const operationsWithBodies = [
    ["triageFacilitiesCase", "  /api/v1/facilities/cases/{case_id}/assign:\n"],
    ["assignFacilitiesCase", "  /api/v1/facilities/cases/{case_id}/start:\n"],
    ["submitFacilitiesExecution", "  /api/v1/facilities/cases/{case_id}/acceptance:\n"],
    ["decideFacilitiesAcceptance", "  /api/v1/facilities/cases/{case_id}/observations:\n"],
    ["recordFacilitiesObservation", undefined],
  ] as const;
  for (const [operationId, nextPath] of operationsWithBodies) {
    const operation = facilitiesPath(operationId, nextPath);
    assert.match(operation, /summary: .+/);
    assert.match(operation, /requestBody: \{ required: true, content: \{ application\/json: \{ schema:/);
    assert.match(operation, /'200': \{ description: .+, content: \{ application\/json: \{ schema: \{ \$ref: '#\/components\/schemas\/FacilitiesCase' \} \} \} \}/);
    for (const status of ["401", "403", "404", "422", "500", "503"]) {
      assert.match(operation, new RegExp(`'${status}': \\{ \\$ref: '#/components/responses/`));
    }
  }

  const start = facilitiesPath("startFacilitiesCase", "  /api/v1/facilities/cases/{case_id}/submit:\n");
  assert.match(start, /summary: .+/);
  assert.doesNotMatch(start, /requestBody:/);
  assert.match(start, /'200': \{ description: .+, content: \{ application\/json: \{ schema: \{ \$ref: '#\/components\/schemas\/FacilitiesCase' \} \} \} \}/);

  const facilitiesCaseSchema = facilitiesPath("recordFacilitiesObservation", undefined)
    ? readFileSync(fileURLToPath(new URL("../../../backend/openapi/openapi.yaml", import.meta.url)), "utf8").slice(
      readFileSync(fileURLToPath(new URL("../../../backend/openapi/openapi.yaml", import.meta.url)), "utf8").indexOf("    FacilitiesCase:\n"),
      readFileSync(fileURLToPath(new URL("../../../backend/openapi/openapi.yaml", import.meta.url)), "utf8").indexOf("    ProductionPlan:\n"),
    )
    : "";
  assert.match(facilitiesCaseSchema, /assigneeId: \{ type: \[string, 'null'\], format: uuid \}/);
  assert.match(facilitiesCaseSchema, /energyDeltaKwh: \{ type: \[string, 'null'\] \}/);
  assert.doesNotMatch(facilitiesCaseSchema, /nullable:/);
});
