import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const openapi = readFileSync("backend/openapi/openapi.yaml", "utf8");
const typescript = readFileSync("clients/ts/src/schema.d.ts", "utf8");

const persistedEnumWires = {
  ComplianceRiskLevel: ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"],
  RegulationImpactStatus: ["DRAFT", "ACTIVE", "SUPERSEDED", "ARCHIVED"],
  ObligationType: ["LEGAL", "REGULATORY", "CONTRACTUAL", "INTERNAL_POLICY", "CONTROL_REQUIREMENT"],
  ComplianceScopeKind: ["ORG", "BRANCH", "SITE", "TEAM", "ROLE"],
  ObligationStatus: ["DRAFT", "ACTIVE", "WAIVED", "SUPERSEDED", "ARCHIVED"],
  ReviewCadence: ["MONTHLY", "QUARTERLY", "SEMI_ANNUAL", "ANNUAL", "EVENT_DRIVEN"],
  FrameworkKind: ["LEGAL_BASELINE", "INTERNAL_CONTROL", "CUSTOMER_CONTROL", "SECURITY_STANDARD", "SAFETY_STANDARD", "AUDIT_PROGRAM"],
  FrameworkStatus: ["DRAFT", "ACTIVE", "RETIRED", "ARCHIVED"],
  ControlType: ["PREVENTIVE", "DETECTIVE", "CORRECTIVE", "DIRECTIVE", "COMPENSATING"],
  ControlCadence: ["CONTINUOUS", "DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "ANNUAL", "EVENT_DRIVEN"],
  ControlStatus: ["DRAFT", "ACTIVE", "RETIRED", "ARCHIVED"],
  ObligationRegulationRelationship: ["DERIVED_FROM", "AMENDED_BY", "SUPERSEDED_BY", "INTERPRETS", "EVIDENCES"],
  CoverageLevel: ["PRIMARY", "PARTIAL", "SUPPORTING", "COMPENSATING"],
  CoverageStatus: ["ACTIVE", "RETIRED"],
  EvidenceTargetType: ["audit_event", "evidence_media", "workflow_run", "workflow_task", "object_link", "governance_finding", "external_document", "future_ev_object"],
  EvidenceBindingStatus: ["PROPOSED", "ACCEPTED", "REJECTED", "EXPIRED", "RETRACTED"],
  EvidenceConfidence: ["LOW", "MEDIUM", "HIGH", "SYSTEM"],
};

function schemaBlock(name) {
  const start = openapi.indexOf(`    ${name}:\n`);
  assert.notEqual(start, -1, `missing ${name} schema`);
  const nextSchema = /^    [^\s][^:\n]*:\n/gm;
  nextSchema.lastIndex = start + name.length + 6;
  const next = nextSchema.exec(openapi);
  return openapi.slice(start, next?.index ?? openapi.length);
}

function enumValues(name) {
  const match = schemaBlock(name).match(/\n      enum: \[([^\]]+)\]/);
  assert.ok(match, `${name} must declare an enum`);
  return match[1].split(",").map((value) => value.trim());
}

test("compliance enums use their persisted as_str values as HTTP wire values", () => {
  for (const [name, expected] of Object.entries(persistedEnumWires)) {
    assert.deepEqual(enumValues(name), expected, name);
  }
});

test("every compliance catalog operation documents its JSON internal-error response", () => {
  const catalogStart = openapi.indexOf("  /api/v1/compliance/regulations:");
  const catalogEnd = openapi.indexOf("  /api/v1/location-consent/status:", catalogStart);
  const catalog = openapi.slice(catalogStart, catalogEnd);
  const operationCount = (catalog.match(/^    (get|post):$/gm) ?? []).length;
  assert.equal(operationCount, 12);
  assert.equal(
    (catalog.match(/'500': \{ \$ref: '#\/components\/responses\/InternalServerError' \}/g) ?? []).length,
    operationCount,
  );
  assert.match(schemaBlock("ErrorBody"), /error:/);
  assert.match(openapi, /    InternalServerError:[\s\S]*?#\/components\/schemas\/ErrorBody/);
});

test("omitted regulation links remain optional in the generated TypeScript request contract", () => {
  const request = schemaBlock("CreateComplianceObligationRequest");
  assert.match(request, /regulation_links: \{ type: array,[\s\S]*Omit to create no regulation links/);
  assert.doesNotMatch(request, /regulation_links:[^\n]*default:/);
  assert.match(
    typescript,
    /regulation_links\?: components\["schemas"\]\["RegulationLinkRequest"\]\[\];/,
  );
});
