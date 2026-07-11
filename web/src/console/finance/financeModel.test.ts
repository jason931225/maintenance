import { describe, expect, it } from "vitest";

import { financeModuleScreen } from "../modules/moduleScreens";
import type { VoucherSummary } from "./financeApi";
import { balanceCheckValue, documentFlowStepper, validateDraft, voucherRow, voucherStatusId, type DraftLine } from "./financeModel";

function record(overrides: Partial<VoucherSummary> = {}): VoucherSummary {
  return {
    id: "v-1",
    voucher_no: "VC-1",
    branch_id: "branch-1",
    status: "DRAFT",
    memo: "임대료 지급",
    source_object_type: null,
    source_object_id: null,
    reversal_of_voucher_id: null,
    reversed_by_voucher_id: null,
    debit_total_won: 100_000,
    credit_total_won: 100_000,
    lines: [
      { id: "line-1", line_no: 1, account_code: "101", side: "DEBIT", amount_won: 100_000, memo: "" },
      { id: "line-2", line_no: 2, account_code: "201", side: "CREDIT", amount_won: 100_000, memo: "" },
    ],
    created_by: "user-1",
    approved_by: null,
    posted_at: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

describe("voucherStatusId", () => {
  it("is a direct lowercase mirror of the real VoucherStatus enum", () => {
    expect(voucherStatusId(record({ status: "DRAFT" }))).toBe("draft");
    expect(voucherStatusId(record({ status: "BALANCE_CHECKED" }))).toBe("balance_checked");
    expect(voucherStatusId(record({ status: "APPROVED" }))).toBe("approved");
    expect(voucherStatusId(record({ status: "POSTED" }))).toBe("posted");
    expect(voucherStatusId(record({ status: "REVERSED" }))).toBe("reversed");
  });
});

describe("documentFlowStepper", () => {
  it("marks every step done once posted, with a posted timestamp", () => {
    const stepper = documentFlowStepper(record({ status: "POSTED", posted_at: "2026-07-09T00:00:00Z" }));
    expect(stepper.steps.map((s) => s.state)).toEqual(["done", "done", "done", "done"]);
    expect(stepper.steps.find((s) => s.key === "post")?.occurredAt).toBeTruthy();
  });

  it("marks approve current while balance-checked", () => {
    const stepper = documentFlowStepper(record({ status: "BALANCE_CHECKED" }));
    expect(stepper.steps.find((s) => s.key === "validate")?.state).toBe("done");
    expect(stepper.steps.find((s) => s.key === "approve")?.state).toBe("current");
    expect(stepper.steps.find((s) => s.key === "post")?.state).toBe("pending");
  });

  it("marks post blocked-with-reason once reversed, all earlier steps done", () => {
    const stepper = documentFlowStepper(record({ status: "REVERSED", posted_at: "2026-07-01T00:00:00Z" }));
    expect(stepper.steps.every((s) => s.state === "done")).toBe(true);
    expect(stepper.steps.find((s) => s.key === "post")?.reasonKey).toBe(
      "console.modules.finance.documentFlow.reversedReason",
    );
  });

  it("leaves everything ahead of entry pending while still a draft", () => {
    const stepper = documentFlowStepper(record({ status: "DRAFT" }));
    expect(stepper.steps.find((s) => s.key === "entry")?.state).toBe("done");
    expect(stepper.steps.find((s) => s.key === "validate")?.state).toBe("current");
    expect(stepper.steps.find((s) => s.key === "approve")?.state).toBe("pending");
  });
});

describe("balanceCheckValue", () => {
  it("is ok when debit and credit totals match and are positive", () => {
    expect(balanceCheckValue(record()).status).toBe("ok");
  });
  it("is blocked when totals diverge", () => {
    const value = balanceCheckValue(record({ debit_total_won: 100_000, credit_total_won: 90_000 }));
    expect(value.status).toBe("blocked");
  });
});

describe("voucherRow", () => {
  it("surfaces one account-drill chip per distinct account code, not a fabricated summary", () => {
    const row = voucherRow(record());
    const glChips = row.linkChips?.filter((chip) => chip.key.startsWith("glAccount:"));
    expect(glChips).toHaveLength(2);
    expect(glChips?.map((chip) => chip.id)).toEqual(["101", "201"]);
  });

  it("resolves 지점 범위/작성자/승인자 to the backend's display names, never the raw id", () => {
    const row = voucherRow(
      record({
        branch_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        branch_name: "남해지사",
        created_by: "111e8400-e29b-41d4-a716-446655440000",
        created_by_name: "김기표",
        approved_by: "222e8400-e29b-41d4-a716-446655440000",
        approved_by_name: "이승인",
      }),
    );
    expect(row.detail?.branchScope).toBe("남해지사");
    expect(row.detail?.createdBy).toBe("김기표");
    expect(row.detail?.approvedBy).toBe("이승인");
  });

  it("falls back to the unknown label rather than a raw uuid when a *_name comes back null", () => {
    const row = voucherRow(
      record({
        branch_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        branch_name: null,
        created_by: "111e8400-e29b-41d4-a716-446655440000",
        created_by_name: null,
      }),
    );
    expect(row.detail?.branchScope).not.toBe("3fa85f64-5717-4562-b3fc-2c963f66afa6");
    expect(row.detail?.createdBy).not.toBe("111e8400-e29b-41d4-a716-446655440000");
  });

  it("omits 승인자 (never a placeholder) before the voucher is approved", () => {
    const row = voucherRow(record({ approved_by: null }));
    expect(row.detail?.approvedBy).toBeUndefined();
  });

  it("fills 전기 시각 with the full post instant when posted, and omits it before posting", () => {
    const posted = voucherRow(record({ status: "POSTED", posted_at: "2026-07-09T05:30:00Z" }));
    // A posting *instant* (YYYY-MM-DD HH:mm), not a bare date — "시각" is a time.
    expect(posted.detail?.postedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(posted.cells.postedAt).toBe(posted.detail?.postedAt);
    // Not yet posted ⇒ omitted (deny-by-omission), never a placeholder timestamp.
    expect(voucherRow(record({ posted_at: null })).detail?.postedAt).toBeUndefined();
    expect(voucherRow(record({ posted_at: null })).cells.postedAt).toBeUndefined();
  });

  it("offers submitVoucher only while draft", () => {
    expect(voucherRow(record({ status: "DRAFT" })).actions?.map((a) => a.key)).toEqual(["submitVoucher"]);
    expect(voucherRow(record({ status: "BALANCE_CHECKED" })).actions?.map((a) => a.key)).toEqual(["approveVoucher"]);
    expect(voucherRow(record({ status: "APPROVED" })).actions?.map((a) => a.key)).toEqual(["postVoucher"]);
    expect(voucherRow(record({ status: "POSTED" })).actions?.map((a) => a.key)).toEqual(["reverseVoucher"]);
    expect(voucherRow(record({ status: "REVERSED" })).actions).toEqual([]);
  });

  it("surfaces the source link chip only when the voucher was derived from a source", () => {
    expect(voucherRow(record()).linkChips?.some((c) => c.key.startsWith("source:"))).toBe(false);
    const derived = voucherRow(record({ source_object_type: "purchase_request", source_object_id: "pr-1" }));
    expect(derived.linkChips?.some((c) => c.key === "source:purchase_request")).toBe(true);
    expect(derived.source?.kind).toBe("purchase_request");
  });
});

describe("validateDraft", () => {
  const balancedLines: DraftLine[] = [
    { line_no: 1, account_code: "101", memo: "", debit_won: "50000", credit_won: "" },
    { line_no: 2, account_code: "201", memo: "", debit_won: "", credit_won: "50000" },
  ];

  it("balances two well-formed lines", () => {
    const result = validateDraft("월 임대료", balancedLines);
    expect(result.balanced).toBe(true);
    expect(result.totalDebit).toBe(50_000);
    expect(result.totalCredit).toBe(50_000);
  });

  it("rejects an empty memo", () => {
    expect(validateDraft("", balancedLines).reasonKey).toBe("console.modules.finance.compose.errors.title");
  });

  it("rejects fewer than two lines", () => {
    expect(validateDraft("t", [balancedLines[0]]).reasonKey).toBe("console.modules.finance.compose.errors.minLines");
  });

  it("rejects an unbalanced total", () => {
    const lines: DraftLine[] = [
      { line_no: 1, account_code: "101", memo: "", debit_won: "50000", credit_won: "" },
      { line_no: 2, account_code: "201", memo: "", debit_won: "", credit_won: "40000" },
    ];
    expect(validateDraft("t", lines).reasonKey).toBe("console.modules.finance.compose.errors.unbalanced");
  });

  it("rejects a line with both debit and credit populated", () => {
    const lines: DraftLine[] = [
      { line_no: 1, account_code: "101", memo: "", debit_won: "10", credit_won: "10" },
      { line_no: 2, account_code: "201", memo: "", debit_won: "", credit_won: "10" },
    ];
    expect(validateDraft("t", lines).reasonKey).toBe("console.modules.finance.compose.errors.onesided");
  });
});

describe("financeModuleScreen fidelity", () => {
  it("marks GL identifiers + 전기 시각 as mono in the detail pane so codes never wrap mid-token", () => {
    // r14: gl/postedAt moved off the master list (folded/detail-only — see
    // the list.columns test below); the mono requirement now lives on the
    // detail fields that still render them.
    const field = (key: string) => financeModuleScreen.detail.fields.find((f) => f.key === key);
    expect(field("glAccountSummary")?.variant).toBe("mono");
    expect(field("postedAt")?.variant).toBe("mono");
  });

  it("keeps the master list to the essential code/title/amount set, folding status+source into the title cell (verdict r14 finance master illegible)", () => {
    expect(financeModuleScreen.list.columns.map((c) => c.key)).toEqual(["code", "title", "amount"]);
    const titleCol = financeModuleScreen.list.columns.find((c) => c.key === "title");
    expect(titleCol?.variant).toBe("titleMeta");
    expect(titleCol?.wrap).toBe(true);
  });
});
