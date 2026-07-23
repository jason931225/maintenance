import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BenefitBody } from "./BenefitBody";

const mockUseAuth = vi.fn();

vi.mock("../../../context/auth", () => ({
  useAuth: () => mockUseAuth() as unknown,
}));

vi.mock("../../policy/authz", () => ({
  DENY_ALL_PROJECTION: { source: "jwt-floor", roles: [], branchScope: { kind: "branches", branches: [] }, capabilities: [] },
  fetchAuthzProjection: vi.fn(async () => ({ source: "authz", roles: ["ADMIN"], branchScope: { kind: "all" }, capabilities: [{ feature: "lifecycle_manage", permission: "allow", branchScope: { kind: "all" } }] })),
  gateAllows: (projection: { capabilities: Array<{ feature: string; permission: string }> }, query: { feature: string }) => projection.capabilities.some((capability) => capability.feature === query.feature && capability.permission === "allow"),
}));

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: "benefit-1",
    benefit_code: "BF-0001",
    category: "legal",
    name: "국민연금",
    scope: { scope_type: "ORG", scope_ref: null, branch_id: null, site_id: null },
    coverage_label: "1,284명",
    covered_count: 1284,
    cost_label: "연 ₩3.42억",
    estimated_annual_cost_won: 342000000,
    employer_rate_bps: 450,
    note: "사업주 부담 4.5%",
    legal_basis: "국민연금법",
    related_domain: "payroll",
    related_object_id: null,
    effective_on: null,
    retires_on: null,
    display_order: 1,
    metadata: {},
    tiers: [{ id: "tier-1", benefit_id: "benefit-1", tier_basis: "가입 기준", tier_key: "전체", value_label: "기준소득월액", amount_won: null, limit_period: null, criteria: {}, display_order: 1 }],
    conditions: [{ id: "condition-1", benefit_id: "benefit-1", condition_kind: "ORG", operator: "exists", condition_key: "org", condition_value: {}, display_label: "전사 적용", cedar_policy_ref: null, display_order: 1 }],
    lifecycle: { object_type: "benefit_catalog_item", object_id: "benefit-1", current_state: "implemented", legal_hold: false, retention_until: null },
    created_by: "user-1",
    updated_by: "user-1",
    created_at: "2026-07-23T00:00:00Z",
    updated_at: "2026-07-23T00:00:00Z",
    ...overrides,
  };
}

function setup(response: unknown = { data: { items: [item()], total: 1, limit: 50, offset: 0 } }) {
  const GET = vi.fn(async () => response);
  const POST = vi.fn(async () => ({ data: { current_state: "retiring" } }));
  mockUseAuth.mockReturnValue({
    api: { GET, POST },
    session: { access_token: "token", org_id: "org-1", user_id: "user-1", client_session_incarnation: "a" },
  });
  return { GET, POST };
}

afterEach(() => mockUseAuth.mockReset());

describe("BenefitBody", () => {
  it("loads the authoritative benefit catalog, presents tiers and eligibility, and drills to the generic lifecycle", async () => {
    const { GET } = setup();
    render(<BenefitBody />);

    expect(await screen.findByRole("heading", { name: "복리후생" })).toBeVisible();
    expect(screen.getByText("국민연금")).toBeVisible();
    expect(screen.getByText("전사 적용")).toBeVisible();
    expect(screen.getByText(/가입 기준/)).toBeVisible();
    expect(GET).toHaveBeenCalledWith("/api/v1/benefit-catalog/items", {
      params: { query: { category: "legal", limit: 50, offset: 0 } },
    });
  });

  it("renders an honest retryable load failure instead of client-created catalog rows", async () => {
    setup({ error: { error: { message: "benefit API unavailable" } } });
    render(<BenefitBody />);
    expect(await screen.findByText("benefit API unavailable")).toBeVisible();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeVisible();
  });

  it("uses the generic lifecycle transition endpoint; it does not invent a benefit transition route", async () => {
    const { POST } = setup();
    render(<BenefitBody />);
    await screen.findByText("국민연금");
    screen.getByRole("button", { name: "다음 상태" }).click();
    await waitFor(() => expect(POST).toHaveBeenCalledWith(
      "/api/v1/lifecycles/{objectType}/{objectId}/transition",
      expect.objectContaining({
        params: { path: { objectType: "benefit_catalog_item", objectId: "benefit-1" } },
        body: expect.objectContaining({ toState: "retiring" }),
      }),
    ));
  });
});
