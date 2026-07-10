// Test helper for surfaces gated by <BulkPolicyGateProvider>. Those surfaces
// batch-resolve their affordances through POST /api/v1/policy/authorize/bulk at
// mount and deny-by-omission until an Allow lands. A page test with an msw
// server (especially `onUnhandledRequest: "error"`) MUST register one of these
// handlers, or every gated control stays hidden and the unhandled POST errors.
//
//   server.use(allowAllBulkAuthorize());   // grant every checked action
//   server.use(denyAllBulkAuthorize());    // deny-by-omission (nothing renders)

import { http, HttpResponse } from "msw";

const BULK_PATH = "*/api/v1/policy/authorize/bulk";

interface BulkBody {
  checks: { action: string }[];
}

function outcome(effect: "allow" | "deny") {
  return { effect, determining_policies: [], errors: [], reason: "" };
}

/** Grant every check in the request (index-aligned decisions all `allow`). */
export function allowAllBulkAuthorize() {
  return http.post(BULK_PATH, async ({ request }) => {
    const body = (await request.json()) as BulkBody;
    return HttpResponse.json({ decisions: body.checks.map(() => outcome("allow")) });
  });
}

/** Deny every check (models a principal with no matching enforced policy). */
export function denyAllBulkAuthorize() {
  return http.post(BULK_PATH, async ({ request }) => {
    const body = (await request.json()) as BulkBody;
    return HttpResponse.json({ decisions: body.checks.map(() => outcome("deny")) });
  });
}

/** Grant only the named actions; everything else deny-by-omission. */
export function bulkAuthorize(allowed: readonly string[]) {
  const allow = new Set(allowed);
  return http.post(BULK_PATH, async ({ request }) => {
    const body = (await request.json()) as BulkBody;
    return HttpResponse.json({
      decisions: body.checks.map((c) => outcome(allow.has(c.action) ? "allow" : "deny")),
    });
  });
}
