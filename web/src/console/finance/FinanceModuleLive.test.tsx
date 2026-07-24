import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../../api/client";
import { GenericModuleScreen } from "../modules/GenericModuleScreen";
import { financeModuleScreen } from "../modules/moduleScreens";
import { PolicyGateProvider, type PolicyGate } from "../policy";
import type { VoucherSummary } from "./financeApi";

const allowGate: PolicyGate = { can: () => true };

const currentPeriod = new Date().toISOString().slice(0, 7);

// APPROVED (not DRAFT/BALANCE_CHECKED) so the offered row action lands on the
// already-localized "postVoucher" label ("전기") rather than the new
// wire-pending submitVoucher/approveVoucher labels — those transitions are
// exhaustively covered against every status in financeModel.test.ts.
const approvedVoucher: VoucherSummary = {
  id: "v-1",
  voucher_no: "VC-1001",
  branch_id: "branch-1",
  status: "APPROVED",
  memo: "임대료 지급",
  source_object_type: "purchase_request",
  source_object_id: "ps-9001",
  reversal_of_voucher_id: null,
  reversed_by_voucher_id: null,
  debit_total_won: 500_000,
  credit_total_won: 500_000,
  lines: [
    { id: "line-1", line_no: 1, account_code: "101", side: "DEBIT", amount_won: 500_000, memo: "" },
    { id: "line-2", line_no: 2, account_code: "201", side: "CREDIT", amount_won: 500_000, memo: "" },
  ],
  created_by: "user-1",
  approved_by: null,
  posted_at: null,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
};

const postedVoucher: VoucherSummary = {
  ...approvedVoucher,
  id: "v-2",
  voucher_no: "VC-1002",
  status: "POSTED",
  approved_by: "user-2",
  posted_at: `${currentPeriod}-09T01:00:00Z`,
};

function createApi() {
  const api = createConsoleApiClient("finance-module-test-token");
  const GET = vi.spyOn(api, "GET").mockImplementation(async (path: unknown) => {
    await Promise.resolve();
    if (path === "/api/v1/finance-gl/vouchers") {
      return { data: [approvedVoucher, postedVoucher] };
    }
    if (path === "/api/v1/finance-gl/vouchers/{voucher_id}") {
      return { data: approvedVoucher };
    }
    if (path === "/api/v1/finance-gl/accounts/{account_code}/entries") {
      return {
        data: [{
          voucher_id: "11111111-1111-4111-8111-111111111111",
          voucher_no: "VC-1001",
          status: "POSTED",
          line_id: "22222222-2222-4222-8222-222222222222",
          account_code: "101",
          side: "DEBIT",
          amount_won: 500_000,
          source_object_type: "purchase_request",
          source_object_id: "pr-9001",
          entry_at: "2026-07-09T01:00:00Z",
        }],
      };
    }
    if (path === "/api/v1/branches") {
      return { data: [{ id: "branch-1", region_id: "region-1", name: "본사", deactivated_at: null, created_at: "2026-01-01T00:00:00Z" }] };
    }
    throw new Error(`unexpected GET ${String(path)}`);
  });
  const POST = vi.spyOn(api, "POST").mockImplementation(async (path: unknown) => {
    await Promise.resolve();
    if (path === "/api/v1/finance-gl/vouchers/{voucher_id}/post") {
      return { data: { ...approvedVoucher, status: "POSTED", posted_at: "2026-07-09T02:00:00Z" } };
    }
    if (path === "/api/v1/finance-gl/vouchers") {
      return { data: { ...approvedVoucher, id: "v-3", voucher_no: "VC-1003", status: "DRAFT" } };
    }
    throw new Error(`unexpected POST ${String(path)}`);
  });
  return { api, GET, POST };
}

function renderFinance(gate: PolicyGate = allowGate) {
  const { api, GET, POST } = createApi();
  const result = render(
    <PolicyGateProvider gate={gate}>
      <GenericModuleScreen config={financeModuleScreen} api={api} />
    </PolicyGateProvider>,
  );
  return { ...result, api, GET, POST };
}

describe("financeModuleScreen — live (final-shape) surface", () => {
  it("lists real vouchers and renders the document-flow stepper, balance-check callout, and account-drill chips for the selected one", async () => {
    renderFinance();

    expect(await screen.findByRole("button", { name: "VC-1001 상세 열기" })).toBeVisible();
    expect(screen.getByRole("button", { name: "VC-1002 상세 열기" })).toBeVisible();

    // Real stat strip computed from the fetched vouchers (§4-11: every stat
    // drills, none hardcoded) — pending (approved-but-not-posted) = 1, this
    // month's posted = 1, auto-derived (has a source) = 2.
    expect(screen.getByText("미결전표 1")).toBeVisible();
    expect(screen.getByText("당월 전기 1")).toBeVisible();
    expect(screen.getByText("자동전표 2")).toBeVisible();

    const detail = within(screen.getByLabelText("전표 상세"));
    await waitFor(() => {
      expect(detail.getByRole("list")).toBeVisible();
    });
    const stepper = within(detail.getByRole("list"));
    expect(stepper.getByText("기표")).toBeVisible();
    expect(stepper.getByText("차대 검증")).toBeVisible();
    expect(stepper.getByText("승인")).toBeVisible();
    expect(stepper.getByText("전기")).toBeVisible();

    // Balance-check callout is ok for a balanced voucher.
    expect(detail.getByText("차대 일치")).toBeVisible();

    // Account-drill: one chip per line, using the real account codes.
    expect(detail.getByText("101")).toBeVisible();
    expect(detail.getByText("201")).toBeVisible();

    // postVoucher is offered once APPROVED; reverseVoucher is not.
    expect(screen.getByRole("button", { name: "전기" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "반제" })).not.toBeInTheDocument();
  });

  it("opens a real account ledger from the selected voucher's account chip and preserves voucher/source identity", async () => {
    const { GET } = renderFinance();

    const accountChip = await screen.findByRole("button", { name: "계정 101" });
    await userEvent.click(accountChip);

    const ledger = await screen.findByRole("region", { name: "계정원장 101" });
    expect(within(ledger).getByText("VC-1001")).toBeVisible();
    expect(within(ledger).getByText("₩500,000")).toBeVisible();
    expect(within(ledger).getByText("purchase_request / pr-9001")).toBeVisible();
    expect(GET).toHaveBeenCalledWith(
      "/api/v1/finance-gl/accounts/{account_code}/entries",
      expect.objectContaining({ params: { path: { account_code: "101" } } }),
    );
  });

  it("discards an older account-ledger response after the operator selects a different account", async () => {
    const first = Promise.withResolvers<{ data: Array<{
      voucher_id: string; voucher_no: string; status: "POSTED"; line_id: string;
      account_code: string; side: "DEBIT"; amount_won: number;
      source_object_type: string; source_object_id: string; entry_at: string;
    }> }>();
    const second = Promise.withResolvers<{ data: Array<{
      voucher_id: string; voucher_no: string; status: "POSTED"; line_id: string;
      account_code: string; side: "CREDIT"; amount_won: number;
      source_object_type: string; source_object_id: string; entry_at: string;
    }> }>();
    const api = createConsoleApiClient("finance-module-test-token");
    let accountCalls = 0;
    vi.spyOn(api, "GET").mockImplementation(async (path: unknown) => {
      if (path === "/api/v1/finance-gl/vouchers") return { data: [approvedVoucher] };
      if (path === "/api/v1/finance-gl/vouchers/{voucher_id}") return { data: approvedVoucher };
      if (path === "/api/v1/finance-gl/accounts/{account_code}/entries") {
        accountCalls += 1;
        return accountCalls === 1 ? first.promise : second.promise;
      }
      if (path === "/api/v1/branches") return { data: [] };
      throw new Error(`unexpected GET ${String(path)}`);
    });
    render(<PolicyGateProvider gate={allowGate}><GenericModuleScreen config={financeModuleScreen} api={api} /></PolicyGateProvider>);

    await userEvent.click(await screen.findByRole("button", { name: "계정 101" }));
    await userEvent.click(screen.getByRole("button", { name: "계정 201" }));
    second.resolve({ data: [{
      voucher_id: "33333333-3333-4333-8333-333333333333",
      voucher_no: "VC-CURRENT",
      status: "POSTED",
      line_id: "44444444-4444-4444-8444-444444444444",
      account_code: "201",
      side: "CREDIT",
      amount_won: 750_000,
      source_object_type: "invoice",
      source_object_id: "invoice-current",
      entry_at: "2026-07-09T01:00:00Z",
    }] });
    expect(await screen.findByText("VC-CURRENT")).toBeVisible();
    first.resolve({ data: [{
      voucher_id: "55555555-5555-4555-8555-555555555555",
      voucher_no: "VC-STALE",
      status: "POSTED",
      line_id: "66666666-6666-4666-8666-666666666666",
      account_code: "101",
      side: "DEBIT",
      amount_won: 500_000,
      source_object_type: "purchase_request",
      source_object_id: "pr-stale",
      entry_at: "2026-07-09T00:00:00Z",
    }] });
    await waitFor(() => {
      expect(screen.getByText("VC-CURRENT")).toBeVisible();
      expect(screen.queryByText("VC-STALE")).not.toBeInTheDocument();
    });
  });

  it("offers reverseVoucher (not postVoucher) once a voucher is posted", async () => {
    renderFinance();

    const postedRowButton = await screen.findByRole("button", { name: "VC-1002 상세 열기" });
    await userEvent.click(postedRowButton);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "반제" })).toBeVisible();
    });
    expect(screen.queryByRole("button", { name: "전기" })).not.toBeInTheDocument();
  });

  it("posts a voucher through the real finance-gl wiring and reflects the new state without a page reload", async () => {
    const { GET } = renderFinance();

    const postButton = await screen.findByRole("button", { name: "전기" });
    await userEvent.click(postButton);

    await waitFor(() => {
      expect(within(screen.getByLabelText("전표 상세")).getAllByText("전기 완료").length).toBeGreaterThan(0);
    });
    expect(GET).toHaveBeenCalled();
  });

  it("opens the real 전표 기안 compose form from the primary action and blocks submit until the draft balances", async () => {
    renderFinance();

    const createButton = await screen.findByRole("button", { name: "전표 생성" });
    await userEvent.click(createButton);

    const form = await screen.findByRole("form", { name: "전표 기안" });
    const submit = within(form).getByRole("button", { name: "기표" });
    expect(submit).toBeDisabled();

    await userEvent.type(within(form).getByLabelText("내용"), "월 임대료");
    const glInputs = within(form).getAllByLabelText("계정과목");
    const debitInputs = within(form).getAllByLabelText("차변");
    const creditInputs = within(form).getAllByLabelText("대변");
    await userEvent.type(glInputs[0], "101");
    await userEvent.type(debitInputs[0], "30000");
    await userEvent.type(glInputs[1], "201");
    await userEvent.type(creditInputs[1], "30000");

    await waitFor(() => {
      expect(submit).not.toBeDisabled();
    });
    await userEvent.click(submit);

    await waitFor(() => {
      expect(screen.queryByRole("form", { name: "전표 기안" })).not.toBeInTheDocument();
    });
  });
});
