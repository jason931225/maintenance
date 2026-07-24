import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../../../api/client";
import { AuthContext, type AuthContextValue } from "../../../context/auth";
import { ModuleFinanceScreenBody } from "./ModuleFinanceScreenBody";

// NOTE: no PolicyGateProvider wrapper here — the body owns its own gate. Mounting
// it bare (exactly as ConsoleShell does) is what proves the R4 blank-plane fix:
// an injected allow-gate previously masked the missing provider.
function renderBody(
  getImpl: (path: unknown) => Promise<unknown>,
  roles: readonly string[] = ["SUPER_ADMIN"],
) {
  const api = createConsoleApiClient("module-finance-screen-test-token");
  vi.spyOn(api, "GET").mockImplementation(getImpl as never);
  const authValue = {
    session: {
      access_token: "module-finance-screen-test-token",
      roles,
      feature_grants: [],
      org_id: "org-1",
      user_id: "user-1",
      branches: ["branch-1"],
    },
    restoring: false,
    login: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
    acceptTokens: vi.fn(),
    clearPasskeySetup: vi.fn(),
    api,
    viewAs: undefined,
    enterViewAs: vi.fn(),
    exitViewAs: vi.fn(),
  } as unknown as AuthContextValue;

  return render(
    <AuthContext.Provider value={authValue}>
      <ModuleFinanceScreenBody />
    </AuthContext.Provider>,
  );
}

const voucherRows = [
  {
    id: "v-1",
    voucher_no: "VC-1001",
    branch_id: "branch-1",
    status: "DRAFT",
    memo: "임대료 지급",
    source_object_type: null,
    source_object_id: null,
    reversal_of_voucher_id: null,
    reversed_by_voucher_id: null,
    debit_total_won: 100_000,
    credit_total_won: 100_000,
    lines: [],
    created_by: "user-1",
    approved_by: null,
    posted_at: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
  },
];

describe("ModuleFinanceScreenBody", () => {
  it("renders the real 재무 shell (title + stat strip) for a granted session with NO ambient gate", async () => {
    renderBody(async (path) => {
      await Promise.resolve();
      if (path === "/api/v1/finance-gl/vouchers") return { data: voucherRows };
      if (path === "/api/v1/financial/purchase-requests") {
        return { data: { items: [], limit: 50, offset: 0, total: 0 } };
      }
      return { data: undefined };
    });

    expect(screen.getByRole("heading", { name: "재무" })).toBeVisible();
    expect(await screen.findByRole("button", { name: "VC-1001 상세 열기" })).toBeVisible();
    // Stat strip drills a real count, not a hardcoded zero.
    expect(screen.getByText("미결전표 1")).toBeVisible();
    expect(await screen.findByRole("heading", { name: "구매요청서" })).toBeVisible();
  });

  it("stays blank for a role without module-read (deny-by-omission — no ledger leaks)", async () => {
    renderBody(async (path) => {
      await Promise.resolve();
      if (path === "/api/v1/finance-gl/vouchers") return { data: voucherRows };
      if (path === "/api/v1/financial/purchase-requests") {
        return { data: { items: [], limit: 50, offset: 0, total: 0 } };
      }
      return { data: undefined };
    }, ["MEMBER"]);

    // The whole surface is gated on config.policy.read; a MEMBER sees nothing.
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "재무" })).toBeNull();
    });
    expect(screen.queryByRole("button", { name: "VC-1001 상세 열기" })).toBeNull();
  });

  it("shows the list-load error state (not a blank/frozen screen) when the real request fails", async () => {
    renderBody(async (path) => {
      await Promise.resolve();
      if (path === "/api/v1/financial/purchase-requests") {
        return { data: { items: [], limit: 50, offset: 0, total: 0 } };
      }
      throw new Error("network down");
    });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeVisible();
    });
  });

  it("shows the live-empty hint (never fabricated rows) when the org has no vouchers yet", async () => {
    renderBody(async (path) => {
      await Promise.resolve();
      if (path === "/api/v1/finance-gl/vouchers") return { data: [] };
      return { data: undefined };
    });

    await waitFor(() => {
      expect(screen.getByText("전표가 없습니다")).toBeVisible();
    });
  });
});
