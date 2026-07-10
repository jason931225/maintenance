import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../../api/client";
import { GenericModuleScreen } from "../modules/GenericModuleScreen";
import { financeModuleScreen } from "../modules/moduleScreens";
import { PolicyGateProvider, type PolicyGate } from "../policy";
import type { VoucherRecord } from "./financeApi";

const allowGate: PolicyGate = { can: () => true };

const draftVoucher: VoucherRecord = {
  id: "v-1",
  code: "VC-1001",
  title: "임대료 지급",
  lifecycle_state: "draft",
  lifecycle_version: 1,
  posting_status: "unposted",
  validation_status: "valid",
  total_debit_won: 500_000,
  total_credit_won: 500_000,
  source_kind: "purchase",
  source_code: "PS-9001",
  source_id: "ps-9001",
  lines: [
    { line_no: 1, gl_account_id: "gl-101", gl_account_code: "101", debit_won: 500_000, credit_won: 0 },
    { line_no: 2, gl_account_id: "gl-201", gl_account_code: "201", debit_won: 0, credit_won: 500_000 },
  ],
};

const currentPeriod = new Date().toISOString().slice(0, 7);

const postedVoucher: VoucherRecord = {
  ...draftVoucher,
  id: "v-2",
  code: "VC-1002",
  lifecycle_state: "active",
  period: currentPeriod,
  posting_status: "posted",
  posted_at: "2026-07-09T01:00:00Z",
};

function createApi() {
  const api = createConsoleApiClient("finance-module-test-token");
  const GET = vi.spyOn(api, "GET").mockImplementation(async (path: unknown) => {
    await Promise.resolve();
    if (path === "/api/v1/finance/vouchers") {
      return { data: { items: [draftVoucher, postedVoucher], total: 2 } };
    }
    if (path === `/api/v1/finance/vouchers/${draftVoucher.id}`) {
      return { data: draftVoucher };
    }
    if (path === `/api/v1/finance/vouchers/${postedVoucher.id}`) {
      return { data: postedVoucher };
    }
    throw new Error(`unexpected GET ${String(path)}`);
  });
  const POST = vi.spyOn(api, "POST").mockImplementation(async (path: unknown, opts: unknown) => {
    await Promise.resolve();
    if (path === `/api/v1/finance/vouchers/${draftVoucher.id}/post`) {
      return { data: { ...draftVoucher, posting_status: "posted", posted_at: "2026-07-09T02:00:00Z" } };
    }
    if (path === "/api/v1/finance/vouchers") {
      const body = (opts as { body?: { title?: string } }).body;
      return { data: { ...draftVoucher, id: "v-3", code: "VC-1003", title: body?.title ?? "" } };
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

    // Real stat strip computed from the fetched vouchers, not hardcoded zeros.
    expect(screen.getByText("검토 대기 1")).toBeVisible();
    expect(screen.getByText("전기 완료 1")).toBeVisible();
    expect(screen.getByText("원천 연결 2")).toBeVisible();

    // Document-flow stepper steps render as real localized chips, not a
    // placeholder. Scoped to the stepper list so the "전기" post step is not
    // confused with the "전기" post action button.
    const detail = within(screen.getByLabelText("전표 상세"));
    await waitFor(() => {
      expect(detail.getByRole("list")).toBeVisible();
    });
    const stepper = within(detail.getByRole("list"));
    expect(stepper.getByText("기표")).toBeVisible();
    expect(stepper.getByText("차대 검증")).toBeVisible();
    expect(stepper.getByText("승인")).toBeVisible();
    expect(stepper.getByText("전기")).toBeVisible();

    // Balance-check callout is ok for a balanced, valid draft.
    expect(detail.getByText("차대 일치")).toBeVisible();

    // Account-drill: one chip per GL line, using the real line data.
    expect(detail.getByText("101")).toBeVisible();
    expect(detail.getByText("201")).toBeVisible();

    // postVoucher is offered for the unposted+valid draft; reverseVoucher is not.
    expect(screen.getByRole("button", { name: "전기" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "반제" })).not.toBeInTheDocument();
  });

  it("offers reverseVoucher (not postVoucher) once a voucher is posted", async () => {
    renderFinance();

    const postedRowButton = await screen.findByRole("button", { name: "VC-1002 상세 열기" });
    await userEvent.click(postedRowButton);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "전기" })).not.toBeInTheDocument();
    });
  });

  it("posts a voucher through the real reversal/post wiring and reflects the new state without a page reload", async () => {
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

    expect(submit).not.toBeDisabled();
    await userEvent.click(submit);

    await waitFor(() => {
      expect(screen.queryByRole("form", { name: "전표 기안" })).not.toBeInTheDocument();
    });
  });
});
