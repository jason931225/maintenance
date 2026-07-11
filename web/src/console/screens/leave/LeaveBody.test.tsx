import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearAuthorizeBulkCache } from "../../../api/authorizeBulk";
import type { LeaveRequestView, LeaveRosterEntry } from "../../../api/types";
import { ko } from "../../../i18n/ko";
import { LeaveBody } from "./LeaveBody";

const S = ko.console.leave;

// useAuth is mocked so the body's self-fetch runs against a spied api client
// (same convention as DashboardBody.test.tsx — no MSW server needed).
const mockUseAuth = vi.fn();
vi.mock("../../../context/auth", () => ({
  useAuth: () => mockUseAuth() as unknown,
}));

const roster: LeaveRosterEntry[] = [
  { employee_id: "emp-1", name: "김현장", team: "정비팀", grant: 20, used: 5, left: 15, tone: "ok" },
  { employee_id: "emp-2", name: "이정비", team: "정비팀", grant: 15, used: 14, left: 1, tone: "promote" },
];

function makeRequest(overrides: Partial<LeaveRequestView> = {}): LeaveRequestView {
  return {
    id: "req-1",
    branch_id: "branch-1",
    requester_user_id: "emp-2-user",
    subject_employee_id: "emp-2",
    leave_type: "annual",
    days: 1,
    start_date: "2026-07-20",
    end_date: "2026-07-20",
    reason: "개인 사유",
    status: "pending",
    decided_by: null,
    decided_at: null,
    created_at: "2026-07-10T00:00:00Z",
    ...overrides,
  };
}

interface AuthOverrides {
  balances?: unknown;
  balancesReject?: boolean;
  requests?: LeaveRequestView[];
  balancesPending?: boolean;
  onDecide?: (path: string, opts: unknown) => unknown;
  onPromote?: (path: string, opts: unknown) => unknown;
}

function setupAuth(overrides: AuthOverrides = {}) {
  const { requests = [makeRequest()], balancesReject = false } = overrides;
  const balances = overrides.balances ?? { items: roster };
  const GET = vi.fn(async (path: string) => {
    await Promise.resolve();
    if (path === "/api/v1/leave/balances") {
      if (overrides.balancesPending) return new Promise(() => {}) as never;
      if (balancesReject) throw new Error("boom");
      return { data: balances };
    }
    if (path === "/api/v1/leave/requests") {
      return { data: { items: requests } };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  const POST = vi.fn(async (path: string, opts: unknown) => {
    await Promise.resolve();
    if (path === "/api/v1/policy/authorize/bulk") {
      // Real-wired PBAC gate (BulkPolicyGateProvider) — allow everything this
      // screen requests so tests exercise LeaveConsole's own persona lenses,
      // not the gate resolve itself.
      const checks = (opts as { body: { checks: { action: string }[] } }).body.checks;
      return { data: { decisions: checks.map(() => ({ effect: "allow" })) } };
    }
    if (path === "/api/v1/leave/requests/{id}/decide") {
      return overrides.onDecide?.(path, opts) ?? { data: makeRequest({ status: "approved" }) };
    }
    if (path === "/api/v1/leave/promotions") {
      return (
        overrides.onPromote?.(path, opts) ?? {
          data: {
            id: "push-1",
            kind: "promotion",
            round: 1,
            target_user_id: "emp-2-user",
            inbox_doc_id: "doc-1",
            ap_submission: "submitted",
          },
        }
      );
    }
    throw new Error(`unexpected POST ${path}`);
  });
  mockUseAuth.mockReturnValue({
    api: { GET, POST },
    session: { user_id: "self-user", org_id: "org-1", roles: ["ADMIN"] },
  });
  return { GET, POST };
}

function renderBody() {
  render(<LeaveBody />);
}

afterEach(() => {
  mockUseAuth.mockReset();
  clearAuthorizeBulkCache();
});

describe("LeaveBody", () => {
  it("shows the loading state before the roster/queue resolve", () => {
    setupAuth({ balancesPending: true });
    renderBody();
    expect(screen.getByText(ko.console.leave.wire.loading)).toBeVisible();
  });

  it("wires the real roster + queue and every stat drills the ledger filter (§4-11)", async () => {
    setupAuth();
    renderBody();

    const ledgerRegion = await screen.findByRole("region", { name: S.ledger.title });
    const table = within(ledgerRegion).getByRole("table");
    expect(within(table).getByText("김현장")).toBeVisible();
    expect(within(table).getByText("이정비")).toBeVisible();

    await userEvent.click(
      screen.getByRole("button", { name: S.stats.drill(S.stats.promotionTargets) }),
    );
    expect(within(table).queryByText("김현장")).toBeNull();
    expect(within(table).getByText("이정비")).toBeVisible();
  });

  it("renders an error state with retry when the balances fetch fails", async () => {
    const { GET } = setupAuth({ balancesReject: true });
    renderBody();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(ko.console.leave.wire.loadFailed);

    GET.mockImplementation(async (path: string) => {
      await Promise.resolve();
      if (path === "/api/v1/leave/balances") return { data: { items: roster } };
      if (path === "/api/v1/leave/requests") return { data: { items: [] } };
      throw new Error(`unexpected GET ${path}`);
    });
    await userEvent.click(screen.getByRole("button", { name: ko.console.leave.wire.retry }));
    const ledgerRegion = await screen.findByRole("region", { name: S.ledger.title });
    await waitFor(() => {
      expect(within(ledgerRegion).getByRole("table").textContent).toContain("김현장");
    });
  });

  it("결재 approve posts the real decide payload (branch-resolved by the request, not guessed)", async () => {
    const { POST } = setupAuth();
    renderBody();

    const queue = await screen.findByRole("region", { name: S.queue.title });
    await userEvent.click(
      within(queue).getByRole("button", { name: S.queue.decideAria(S.queue.approve, "이정비") }),
    );

    expect(POST).toHaveBeenCalledWith(
      "/api/v1/leave/requests/{id}/decide",
      expect.objectContaining({
        params: { path: { id: "req-1" } },
        body: { decision: "approve", comment: undefined },
      }),
    );
  });

  it("사용촉진 발송 posts the real promotion payload with the request's branch_id", async () => {
    const { POST } = setupAuth();
    renderBody();

    const promotionRegion = await screen.findByRole("region", { name: S.promotion.queueTitle });
    await userEvent.click(
      within(promotionRegion).getByRole("button", { name: S.promotion.sendAria("이정비", 1) }),
    );

    expect(POST).toHaveBeenCalledWith(
      "/api/v1/leave/promotions",
      expect.objectContaining({
        body: {
          branch_id: "branch-1",
          target_user_id: "emp-2-user",
          target_employee_id: "emp-2",
          target_name: "이정비",
          round: 1,
          unused_days: 1,
        },
      }),
    );
    await screen.findByText(S.promotion.pushed);
  });
});
