import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BenefitBody } from "./BenefitBody";

const mockUseAuth = vi.fn();

vi.mock("../../../context/auth", () => ({
  useAuth: () => mockUseAuth() as unknown,
}));

vi.mock("../../policy/authz", () => ({
  DENY_ALL_PROJECTION: {
    source: "jwt-floor",
    roles: [],
    branchScope: { kind: "branches", branches: [] },
    capabilities: [],
  },
  fetchAuthzProjection: vi.fn(() =>
    Promise.resolve({
      source: "authz",
      roles: ["ADMIN"],
      branchScope: { kind: "all" },
      capabilities: [
        {
          feature: "lifecycle_manage",
          permission: "allow",
          branchScope: { kind: "all" },
        },
        {
          feature: "benefit_catalog_manage",
          permission: "allow",
          branchScope: { kind: "all" },
        },
      ],
    }),
  ),
  gateAllows: (
    projection: {
      capabilities: Array<{ feature: string; permission: string }>;
    },
    query: { feature: string },
  ) =>
    projection.capabilities.some(
      (capability) =>
        capability.feature === query.feature &&
        capability.permission === "allow",
    ),
}));

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: "benefit-1",
    benefit_code: "BF-0001",
    category: "legal",
    name: "국민연금",
    scope: {
      scope_type: "ORG",
      scope_ref: null,
      branch_id: null,
      site_id: null,
    },
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
    tiers: [
      {
        id: "tier-1",
        benefit_id: "benefit-1",
        tier_basis: "가입 기준",
        tier_key: "전체",
        value_label: "기준소득월액",
        amount_won: null,
        limit_period: null,
        criteria: {},
        display_order: 1,
      },
    ],
    conditions: [
      {
        id: "condition-1",
        benefit_id: "benefit-1",
        condition_kind: "ORG",
        operator: "exists",
        condition_key: "org",
        condition_value: {},
        display_label: "전사 적용",
        cedar_policy_ref: null,
        display_order: 1,
      },
    ],
    lifecycle: {
      object_type: "benefit_catalog_item",
      object_id: "benefit-1",
      current_state: "implemented",
      legal_hold: false,
      retention_until: null,
    },
    created_by: "user-1",
    updated_by: "user-1",
    created_at: "2026-07-23T00:00:00Z",
    updated_at: "2026-07-23T00:00:00Z",
    ...overrides,
  };
}

function setup(
  response: unknown = {
    data: { items: [item()], total: 1, limit: 50, offset: 0 },
  },
) {
  const GET = vi.fn(() => Promise.resolve(response));
  const POST = vi.fn(() => Promise.resolve({ data: item() }));
  const PATCH = vi.fn(() => Promise.resolve({ data: item() }));
  const PUT = vi.fn(() => Promise.resolve({ data: item() }));
  mockUseAuth.mockReturnValue({
    api: { GET, POST, PATCH, PUT },
    session: {
      access_token: "token",
      org_id: "org-1",
      user_id: "user-1",
      client_session_incarnation: "a",
    },
  });
  return { GET, POST, PATCH, PUT };
}

afterEach(() => mockUseAuth.mockReset());

describe("BenefitBody", () => {
  it("loads the authoritative benefit catalog, presents tiers and eligibility, and drills to the generic lifecycle", async () => {
    const { GET } = setup();
    render(<BenefitBody />);

    expect(
      await screen.findByRole("heading", { name: "복리후생" }),
    ).toBeVisible();
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

  it("uses the generic lifecycle transition endpoint and refreshes the catalog", async () => {
    const { GET, POST } = setup();
    render(<BenefitBody />);
    await screen.findByText("국민연금");
    screen.getByRole("button", { name: "다음 상태" }).click();
    await waitFor(() => {
      expect(POST).toHaveBeenCalledWith(
        "/api/v1/lifecycles/{objectType}/{objectId}/transition",
        expect.objectContaining({
          params: {
            path: { objectType: "benefit_catalog_item", objectId: "benefit-1" },
          },
          body: expect.objectContaining({ toState: "retiring" }),
        }),
      );
    });
    await waitFor(() => {
      expect(GET).toHaveBeenCalledTimes(2);
    });
  });

  it("creates a real typed catalog item with its first tier and eligibility condition", async () => {
    const { POST } = setup();
    render(<BenefitBody />);
    await screen.findByText("국민연금");
    fireEvent.click(screen.getByRole("button", { name: "정책 등록" }));
    fireEvent.change(screen.getByLabelText("정책명"), {
      target: { value: "건강 검진" },
    });
    fireEvent.change(screen.getByLabelText("적용 범위 설명"), {
      target: { value: "전 직원" },
    });
    fireEvent.change(screen.getByLabelText("비용 설명"), {
      target: { value: "회사 부담" },
    });
    fireEvent.change(screen.getByLabelText("등급 설명"), {
      target: { value: "기본 검진" },
    });
    fireEvent.click(
      within(
        screen.getByRole("form", { name: "복리후생 정책 등록" }),
      ).getByRole("button", { name: "정책 등록" }),
    );
    await waitFor(() => {
      expect(POST).toHaveBeenCalledWith(
        "/api/v1/benefit-catalog/items",
        expect.objectContaining({
          body: expect.objectContaining({
            name: "건강 검진",
            scope: { scope_type: "ORG" },
            tiers: [expect.objectContaining({ tier_basis: "적용 기준" })],
            conditions: [
              expect.objectContaining({ condition_value: { value: "전체" } }),
            ],
          }),
        }),
      );
    });
  });

  it("edits only item fields and preserves every existing tier and condition", async () => {
    const { PATCH, PUT } = setup();
    render(<BenefitBody />);
    await screen.findByText("국민연금");
    fireEvent.click(screen.getByRole("button", { name: "정책 수정" }));
    fireEvent.change(screen.getByLabelText("정책명"), {
      target: { value: "국민연금 개정" },
    });
    fireEvent.click(screen.getByRole("button", { name: "변경 저장" }));
    await waitFor(() => {
      expect(PATCH).toHaveBeenCalledWith(
        "/api/v1/benefit-catalog/items/{benefit_id}",
        expect.objectContaining({
          params: { path: { benefit_id: "benefit-1" } },
        }),
      );
    });
    expect(PUT).not.toHaveBeenCalled();
  });

  it("does not retire a multi-child catalog when an item-only save fails", async () => {
    const multiChild = item({
      tiers: [
        item().tiers[0],
        {
          ...item().tiers[0],
          id: "tier-2",
          tier_key: "manager",
          value_label: "관리자 기준",
        },
      ],
      conditions: [
        item().conditions[0],
        {
          ...item().conditions[0],
          id: "condition-2",
          condition_key: "employment_type",
          display_label: "정규직",
        },
      ],
    });
    const { PATCH, PUT } = setup({
      data: { items: [multiChild], total: 1, limit: 50, offset: 0 },
    });
    PATCH.mockResolvedValueOnce({
      error: { error: { message: "정책 저장 실패" } },
    });
    render(<BenefitBody />);
    await screen.findByText("국민연금");
    fireEvent.click(screen.getByRole("button", { name: "정책 수정" }));
    expect(screen.queryByLabelText("등급 설명")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("적격성 설명")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("정책명"), {
      target: { value: "국민연금 개정" },
    });
    fireEvent.click(screen.getByRole("button", { name: "변경 저장" }));
    await waitFor(() => {
      expect(PATCH).toHaveBeenCalledOnce();
    });
    expect(PUT).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent("정책 저장 실패");
  });
});
