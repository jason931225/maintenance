import { afterEach, describe, expect, it, vi } from "vitest";

import {
  gateAllows,
  featureGrantsFromAuthzProjection,
  fetchAuthzProjection,
  jwtFloorProjection,
  parseAuthzResponse,
  type AuthzProjection,
} from "./authz";

const B1 = "11111111-1111-4111-8111-111111111111";
const B2 = "22222222-2222-4222-8222-222222222222";

function projection(overrides: Partial<AuthzProjection> = {}): AuthzProjection {
  return {
    source: "authz",
    roles: [],
    branchScope: { kind: "all" },
    capabilities: [],
    ...overrides,
  };
}

describe("gateAllows", () => {
  it("denies a feature that is absent (deny-by-omission)", () => {
    expect(gateAllows(projection(), { feature: "role_manage" })).toBe(false);
  });

  it("allows a present feature at the required rank", () => {
    const p = projection({
      capabilities: [{ feature: "role_manage", permission: "allow", branchScope: { kind: "all" } }],
    });
    expect(gateAllows(p, { feature: "role_manage" })).toBe(true);
  });

  it("denies when the capability rank is below minPermission", () => {
    const p = projection({
      capabilities: [
        { feature: "approve", permission: "request_only", branchScope: { kind: "all" } },
      ],
    });
    expect(gateAllows(p, { feature: "approve" })).toBe(false); // default min = allow
    expect(gateAllows(p, { feature: "approve", minPermission: "request_only" })).toBe(true);
  });

  it("intersects a branch-scoped grant against the target branch", () => {
    const p = projection({
      capabilities: [
        { feature: "dispatch_manage", permission: "allow", branchScope: { kind: "branches", branches: [B1] } },
      ],
    });
    expect(gateAllows(p, { feature: "dispatch_manage", branch: B1 })).toBe(true);
    expect(gateAllows(p, { feature: "dispatch_manage", branch: B2 })).toBe(false);
    // No target branch: offered on the caller's best scope (per-row intersection is the caller's job).
    expect(gateAllows(p, { feature: "dispatch_manage" })).toBe(true);
  });

  it("an all-scope grant allows any branch", () => {
    const p = projection({
      capabilities: [{ feature: "x", permission: "allow", branchScope: { kind: "all" } }],
    });
    expect(gateAllows(p, { feature: "x", branch: B2 })).toBe(true);
  });
});

describe("parseAuthzResponse", () => {
  it("parses capabilities + branch_scope, dropping unknown permissions (fail closed)", () => {
    const p = parseAuthzResponse({
      roles: ["ADMIN", 7],
      branch_scope: { kind: "branches", branches: [B1] },
      capabilities: [
        { feature: "role_manage", permission: "allow", branch_scope: { kind: "all" } },
        { feature: "bad", permission: "deny", branch_scope: { kind: "all" } },
        { feature: "narrow", permission: "limited", branch_scope: { kind: "branches", branches: [B1] } },
        { permission: "allow" }, // missing feature -> dropped
      ],
    });
    expect(p.source).toBe("authz");
    expect(p.roles).toEqual(["ADMIN"]);
    expect(p.branchScope).toEqual({ kind: "branches", branches: [B1] });
    expect(p.capabilities.map((c) => c.feature)).toEqual(["role_manage", "narrow"]);
    expect(p.capabilities[1].branchScope).toEqual({ kind: "branches", branches: [B1] });
  });

  it("tolerates a malformed body", () => {
    expect(parseAuthzResponse(null).capabilities).toEqual([]);
    expect(parseAuthzResponse({ capabilities: "nope" }).capabilities).toEqual([]);
  });

  it("projects live allow capabilities into the shared UI feature-grant list", () => {
    const p = parseAuthzResponse({
      capabilities: [
        { feature: "sales_manage", permission: "allow" },
        { feature: "sales_read", permission: "limited" },
        { feature: "sales_manage", permission: "allow" },
      ],
    });
    expect(featureGrantsFromAuthzProjection(p)).toEqual(["sales_manage"]);
  });

  it("accepts legacy feature_grants only when capabilities are absent", () => {
    expect(featureGrantsFromAuthzProjection(parseAuthzResponse({
      feature_grants: ["sales_manage"],
    }))).toEqual(["sales_manage"]);
    expect(featureGrantsFromAuthzProjection(parseAuthzResponse({
      feature_grants: ["sales_manage"],
      capabilities: [],
    }))).toEqual([]);
  });
});

describe("jwtFloorProjection (fail-closed fallback)", () => {
  it("maps JWT feature grants to allow capabilities scoped to JWT branches", () => {
    const p = jwtFloorProjection({ feature_grants: ["role_manage"], branches: [B1] });
    expect(p.source).toBe("jwt-floor");
    expect(gateAllows(p, { feature: "role_manage" })).toBe(true);
    expect(gateAllows(p, { feature: "role_manage", branch: B1 })).toBe(true);
    // Branch outside the JWT membership set is denied.
    expect(gateAllows(p, { feature: "role_manage", branch: B2 })).toBe(false);
    // A feature with no JWT grant is denied (built-in roles are not projected).
    expect(gateAllows(p, { feature: "dispatch_manage" })).toBe(false);
  });

  it("an empty/undefined session grants nothing", () => {
    expect(jwtFloorProjection(undefined).capabilities).toEqual([]);
    expect(gateAllows(jwtFloorProjection({}), { feature: "anything" })).toBe(false);
  });
});


describe("fetchAuthzProjection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetch(...responses: unknown[]) {
    const fetch = vi.fn();
    for (const response of responses) {
      if (response instanceof Error) fetch.mockRejectedValueOnce(response);
      else fetch.mockResolvedValueOnce(response);
    }
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  function okJson(body: unknown) {
    return {
      ok: true,
      json: () => Promise.resolve(body),
    } as Response;
  }

  it("returns a parsed authoritative projection on success", async () => {
    const fetch = mockFetch(okJson({
      roles: ["ADMIN"],
      branch_scope: { kind: "all" },
      capabilities: [
        { feature: "role_manage", permission: "allow", branch_scope: { kind: "all" } },
      ],
    }));
    const result = await fetchAuthzProjection("token", new AbortController().signal, {
      attempts: 1,
      timeoutMs: 100,
      backoffMs: 0,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(result?.source).toBe("authz");
    expect(result?.capabilities[0]?.feature).toBe("role_manage");
  });

  it("retries transient failures before returning the projection", async () => {
    const fetch = mockFetch(new Error("temporary"), okJson({ capabilities: [] }));
    const result = await fetchAuthzProjection(undefined, new AbortController().signal, {
      attempts: 2,
      timeoutMs: 100,
      backoffMs: 0,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result?.source).toBe("authz");
  });

  it("resolves undefined for non-ok responses, thrown errors, and aborted requests", async () => {
    mockFetch({ ok: false });
    await expect(fetchAuthzProjection(undefined, new AbortController().signal, {
      attempts: 1,
      timeoutMs: 100,
      backoffMs: 0,
    })).resolves.toBeUndefined();

    mockFetch(new Error("network"));
    await expect(fetchAuthzProjection(undefined, new AbortController().signal, {
      attempts: 1,
      timeoutMs: 100,
      backoffMs: 0,
    })).resolves.toBeUndefined();

    const controller = new AbortController();
    controller.abort();
    const fetch = mockFetch(okJson({ capabilities: [] }));
    await expect(fetchAuthzProjection(undefined, controller.signal, {
      attempts: 1,
      timeoutMs: 100,
      backoffMs: 0,
    })).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
