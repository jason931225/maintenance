import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function between(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return text.slice(startIndex, endIndex);
}

const operations = [
  {
    path: "/api/v1/consulting/engagements/{engagement_id}/diagnostics",
    operation: "createConsultingDiagnostic",
    nextPath: "/api/v1/consulting/engagements/{engagement_id}/findings",
    nextOperation: "createConsultingFinding",
  },
  {
    path: "/api/v1/consulting/engagements/{engagement_id}/findings",
    operation: "createConsultingFinding",
    nextPath: "/api/v1/consulting/engagements/{engagement_id}/initiatives",
    nextOperation: "createConsultingInitiative",
  },
  {
    path: "/api/v1/consulting/engagements/{engagement_id}/initiatives",
    operation: "createConsultingInitiative",
    nextPath: "/api/v1/consulting/engagements/{engagement_id}/transition",
    nextOperation: "transitionConsultingEngagement",
  },
  {
    path: "/api/v1/consulting/engagements/{engagement_id}/observations",
    operation: "createConsultingBenefitObservation",
    nextPath: "/api/v1/consulting/engagements/{engagement_id}/history",
    nextOperation: "listConsultingEngagementHistory",
  },
];

test("terminal consulting child mutations expose typed conflicts in OpenAPI and generated clients", () => {
  const openapi = read("backend/openapi/openapi.yaml");
  const typescript = read("clients/ts/src/schema.d.ts");
  const kotlin = read(
    "clients/kotlin/src/main/kotlin/com/maintenance/api/client/api/ConsultingApi.kt",
  );
  const swift = read(
    "clients/swift/Sources/MaintenanceAPIClient/Generated/Types.swift",
  );

  for (const { path, operation, nextPath, nextOperation } of operations) {
    const openapiOperation = between(
      openapi,
      `  ${path}:\n`,
      `  ${nextPath}:\n`,
    );
    assert.match(
      openapiOperation,
      /'409': \{ \$ref: '#\/components\/responses\/Conflict' \}/,
      `${operation} must declare the shared Conflict response`,
    );

    const typescriptOperation = between(
      typescript,
      `    ${operation}: {\n`,
      `    ${nextOperation}: {\n`,
    );
    assert.match(
      typescriptOperation,
      /            409: components\["responses"\]\["Conflict"\];\n/,
      `${operation} must expose a typed 409 response in TypeScript`,
    );

    const swiftOperation = between(
      swift,
      `    public enum ${operation[0].toUpperCase()}${operation.slice(1)} {\n`,
      `    public enum ${nextOperation[0].toUpperCase()}${nextOperation.slice(1)} {\n`,
    );
    assert.match(
      swiftOperation,
      /            case conflict\(Components\.Responses\.Conflict\)\n/,
      `${operation} must expose a typed conflict case in Swift`,
    );

    const kotlinOperation = between(
      kotlin,
      `    suspend fun ${operation}(`,
      `    suspend fun ${operation}WithHttpInfo(`,
    );
    assert.match(kotlinOperation, /ResponseType\.ClientError/);
    assert.match(kotlinOperation, /localVarError\.statusCode/);
  }
});
