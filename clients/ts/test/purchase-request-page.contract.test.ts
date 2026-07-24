import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { components, operations } from "../src/schema.js";

type PurchaseRequestPage = components["schemas"]["PurchaseRequestPage"];
type ErrorBody = components["schemas"]["ErrorBody"];
type ListPurchaseRequestsQuery = NonNullable<
  operations["listPurchaseRequests"]["parameters"]["query"]
>;

const branchId = "00000000-0000-0000-0000-0000000000a1";
const queueQuery = {
  branch_id: branchId,
  status: ["STATEMENT_ATTACHED", "REQUEST_SUBMITTED"],
  limit: 25,
  offset: 0,
} satisfies ListPurchaseRequestsQuery;

const purchaseRequestPage = {
  items: [],
  limit: 25,
  offset: 0,
  total: 0,
} satisfies PurchaseRequestPage;

const errorBody = {
  error: {
    code: "validation_error",
    message: "branch_id is required",
  },
} satisfies ErrorBody;

function serializePlainRepeatedStatus(query: ListPurchaseRequestsQuery): string {
  const params = new URLSearchParams({ branch_id: query.branch_id });
  for (const status of query.status ?? []) {
    params.append("status", status);
  }
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.offset !== undefined) params.set("offset", String(query.offset));
  return params.toString();
}

test("purchase-request queue contract uses plain repeated status keys", () => {
  assert.equal(
    serializePlainRepeatedStatus(queueQuery),
    "branch_id=00000000-0000-0000-0000-0000000000a1&status=STATEMENT_ATTACHED&status=REQUEST_SUBMITTED&limit=25&offset=0",
  );
});

test("purchase-request queue page metadata and canonical errors are required", () => {
  const decodedPage = JSON.parse(JSON.stringify(purchaseRequestPage)) as PurchaseRequestPage;
  const decodedError = JSON.parse(JSON.stringify(errorBody)) as ErrorBody;

  for (const key of ["items", "limit", "offset", "total"] as const) {
    assert.equal(Object.hasOwn(decodedPage, key), true);
  }
  assert.equal(decodedError.error.code, "validation_error");
});

test("purchase-request OpenAPI operation preserves strict wire serialization and error responses", () => {
  const specification = readFileSync(
    fileURLToPath(new URL("../../../backend/openapi/openapi.yaml", import.meta.url)),
    "utf8",
  );
  const operation = specification.slice(
    specification.indexOf("  /api/v1/financial/purchase-requests:\n"),
    specification.indexOf("  /api/v1/financial/purchase-requests/{purchaseRequestId}:\n"),
  );

  assert.match(operation, /- name: status\n        in: query\n        required: false\n        description:[\s\S]*?\n        style: form\n        explode: true/);
  assert.match(operation, /\$ref: '#\/components\/schemas\/PurchaseRequestPage'/);
  for (const status of ["401", "403", "422", "500"]) {
    assert.match(operation, new RegExp(`'${status}':`));
  }
  assert.match(operation, /\$ref: '#\/components\/schemas\/ErrorBody'/);
});

// Compile-time contract: pagination metadata is not optional.
// @ts-expect-error PurchaseRequestPage.total is required.
const missingTotal: PurchaseRequestPage = { items: [], limit: 25, offset: 0 };
void missingTotal;
