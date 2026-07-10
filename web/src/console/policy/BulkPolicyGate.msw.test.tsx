// End-to-end proof that a surface gated by <BulkPolicyGateProvider> renders its
// affordances only after a real POST /api/v1/policy/authorize/bulk round-trip
// through the generated client, using the shared test helper the page suites
// consume (src/test/policyGateMock).

import { render, screen, waitFor } from "@testing-library/react";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { clearAuthorizeBulkCache } from "../../api/authorizeBulk";
import { createConsoleApiClient } from "../../api/client";
import type { AuthSession } from "../../context/auth";
import { AuthTestProvider } from "../../test/AuthTestProvider";
import {
  allowAllBulkAuthorize,
  bulkAuthorize,
  denyAllBulkAuthorize,
} from "../../test/policyGateMock";
import { BulkPolicyGateProvider, PolicyGated } from "./index";

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  clearAuthorizeBulkCache();
});

const session: AuthSession = {
  access_token: "t",
  user_id: "u1",
  org_id: "11111111-1111-4111-8111-111111111111",
  roles: ["ADMIN"],
};

function mount() {
  return render(
    <AuthTestProvider session={session} overrides={{ api: createConsoleApiClient("t") }}>
      <BulkPolicyGateProvider actions={["a.read", "a.write"]}>
        <PolicyGated action="a.read">
          <span>READ</span>
        </PolicyGated>
        <PolicyGated action="a.write">
          <span>WRITE</span>
        </PolicyGated>
      </BulkPolicyGateProvider>
    </AuthTestProvider>,
  );
}

describe("BulkPolicyGateProvider over the real client (msw helper)", () => {
  it("shows every affordance when the bulk endpoint allows all", async () => {
    server.use(allowAllBulkAuthorize());
    mount();
    await waitFor(() => {
      expect(screen.getByText("READ")).toBeInTheDocument();
    });
    expect(screen.getByText("WRITE")).toBeInTheDocument();
  });

  it("renders per-action decisions (allow shown, deny hidden)", async () => {
    server.use(bulkAuthorize(["a.read"]));
    mount();
    await waitFor(() => {
      expect(screen.getByText("READ")).toBeInTheDocument();
    });
    expect(screen.queryByText("WRITE")).not.toBeInTheDocument();
  });

  it("hides everything under deny-by-omission", async () => {
    server.use(denyAllBulkAuthorize());
    mount();
    await waitFor(() => {
      expect(screen.queryByText("READ")).not.toBeInTheDocument();
    });
    expect(screen.queryByText("WRITE")).not.toBeInTheDocument();
  });
});
