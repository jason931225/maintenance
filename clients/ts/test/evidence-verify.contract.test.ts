import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { operations } from "../src/schema.js";

type VerifyResponses = operations["verifyEvidenceObject"]["responses"];
type VerifyUnauthorized = VerifyResponses[401]["content"]["application/json"];
type VerifyForbidden = VerifyResponses[403]["content"]["application/json"];
type VerifyUnavailable = VerifyResponses[503]["content"]["application/json"];

const unauthorized = {
  error: { code: "unauthorized", message: "missing bearer token" },
} satisfies VerifyUnauthorized;

const forbidden = {
  error: { code: "forbidden", message: "role does not grant evidence verification" },
} satisfies VerifyForbidden;

const evidenceStoreUnavailable = {
  error: {
    code: "evidence_store_unavailable",
    message: "evidence storage is not configured for fixity verification",
  },
} satisfies VerifyUnavailable;

const genericUnavailable = {
  error: { code: "unavailable", message: "JWT verification is not configured for evidence API" },
} satisfies VerifyUnavailable;

test("generated verify operation retains typed authorization and availability error envelopes", () => {
  assert.equal(unauthorized.error.code, "unauthorized");
  assert.equal(forbidden.error.code, "forbidden");
  assert.equal(evidenceStoreUnavailable.error.code, "evidence_store_unavailable");
  assert.equal(genericUnavailable.error.code, "unavailable");
});

test("verify OpenAPI contract documents storage-specific and generic 503 semantics", () => {
  const specification = readFileSync(
    fileURLToPath(new URL("../../../backend/openapi/openapi.yaml", import.meta.url)),
    "utf8",
  );
  const operation = specification.slice(
    specification.indexOf("  /api/v1/evidence/objects/{id}/verify:\n"),
    specification.indexOf("  /api/v1/evidence/objects/{id}/hold:\n"),
  );

  for (const status of ["401", "403", "503"]) {
    assert.match(operation, new RegExp(`'${status}':`));
  }
  assert.match(operation, /\$ref: '#\/components\/schemas\/ErrorBody'/);
  assert.match(operation, /evidence_store_unavailable/);
  assert.match(operation, /generic.*unavailable|unavailable.*generic/is);
});
