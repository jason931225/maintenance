import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../../../api/client";
import { AuthContext, type AuthContextValue } from "../../../context/auth";
import { PolicyGateProvider, type PolicyGate } from "../../policy";
import { ModuleFinanceScreenBody } from "./ModuleFinanceScreenBody";

const allowGate: PolicyGate = { can: () => true };

function renderBody(getImpl: (path: unknown) => Promise<unknown>, gate: PolicyGate = allowGate) {
  const api = createConsoleApiClient("module-finance-screen-test-token");
  vi.spyOn(api, "GET").mockImplementation(getImpl as never);
  const authValue = {
    session: { access_token: "module-finance-screen-test-token", roles: ["ADMIN"] },
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
      <PolicyGateProvider gate={gate}>
        <ModuleFinanceScreenBody />
      </PolicyGateProvider>
    </AuthContext.Provider>,
  );
}

describe("ModuleFinanceScreenBody", () => {
  it("renders the real 재무 shell (title + stat strip) bound to the authenticated api client", async () => {
    renderBody(async (path) => {
      await Promise.resolve();
      if (path === "/api/v1/finance-gl/vouchers") {
        return {
          data: [
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
          ],
        };
      }
      return { data: undefined };
    });

    expect(screen.getByRole("heading", { name: "재무" })).toBeVisible();
    expect(await screen.findByRole("button", { name: "VC-1001 상세 열기" })).toBeVisible();
    // Stat strip drills a real count, not a hardcoded zero.
    expect(screen.getByText("미결전표 1")).toBeVisible();
  });

  it("shows the list-load error state (not a blank/frozen screen) when the real request fails", async () => {
    renderBody(async () => {
      await Promise.resolve();
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
