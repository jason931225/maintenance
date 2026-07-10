import { describe, expect, it } from "vitest";

import type { VoucherRecord } from "./financeApi";
import { balanceCheckValue, documentFlowStepper, validateDraft, voucherRow, voucherStatusId, type DraftLine } from "./financeModel";

function record(overrides: Partial<VoucherRecord> = {}): VoucherRecord {
  return {
    id: "v-1",
    code: "VC-1",
    title: "임대료 지급",
    lifecycle_state: "draft",
    lifecycle_version: 1,
    posting_status: "unposted",
    validation_status: "valid",
    total_debit_won: 100_000,
    total_credit_won: 100_000,
    lines: [
      { line_no: 1, gl_account_id: "gl-101", debit_won: 100_000, credit_won: 0 },
      { line_no: 2, gl_account_id: "gl-201", debit_won: 0, credit_won: 100_000 },
    ],
    ...overrides,
  };
}

describe("voucherStatusId", () => {
  it("prefers validation failure over posting/lifecycle", () => {
    expect(voucherStatusId(record({ validation_status: "unbalanced" }))).toBe("invalid");
  });
  it("reports posted once posting_status is posted", () => {
    expect(voucherStatusId(record({ posting_status: "posted" }))).toBe("posted");
  });
  it("falls back to lifecycle_state when unposted and valid", () => {
    expect(voucherStatusId(record({ lifecycle_state: "review" }))).toBe("review");
  });
});

describe("documentFlowStepper", () => {
  it("marks validate blocked with a reason when validation fails", () => {
    const stepper = documentFlowStepper(record({ validation_status: "unbalanced" }));
    const validate = stepper.steps.find((step) => step.key === "validate");
    expect(validate?.state).toBe("blocked");
    expect(validate?.reasonKey).toBe("console.modules.finance.validationReasons.unbalanced");
  });

  it("marks post done with a posted timestamp once posted", () => {
    const stepper = documentFlowStepper(record({ posting_status: "posted", posted_at: "2026-07-09T00:00:00Z" }));
    const post = stepper.steps.find((step) => step.key === "post");
    expect(post?.state).toBe("done");
    expect(post?.occurredAt).toBeTruthy();
  });

  it("marks approve current while lifecycle is under review", () => {
    const stepper = documentFlowStepper(record({ lifecycle_state: "review" }));
    expect(stepper.steps.find((step) => step.key === "approve")?.state).toBe("current");
  });
});

describe("balanceCheckValue", () => {
  it("is ok when validation is valid and totals match", () => {
    expect(balanceCheckValue(record()).status).toBe("ok");
  });
  it("is blocked when validation fails, carrying the reason", () => {
    const value = balanceCheckValue(record({ validation_status: "invalid_gl_account" }));
    expect(value.status).toBe("blocked");
    expect(value.reasonKey).toBe("console.modules.finance.validationReasons.invalid_gl_account");
  });
});

describe("voucherRow", () => {
  it("surfaces one account-drill chip per distinct GL line, not a fabricated summary", () => {
    const row = voucherRow(record());
    const glChips = row.linkChips?.filter((chip) => chip.key.startsWith("glAccount:"));
    expect(glChips).toHaveLength(2);
    expect(glChips?.map((chip) => chip.id)).toEqual(["gl-101", "gl-201"]);
  });

  it("only offers postVoucher when unposted+valid+draft-or-review (mirrors validate_post_transition)", () => {
    expect(voucherRow(record()).actions?.map((a) => a.key)).toContain("postVoucher");
    expect(voucherRow(record({ validation_status: "unbalanced" })).actions?.map((a) => a.key)).not.toContain(
      "postVoucher",
    );
  });

  it("only offers reverseVoucher once posted", () => {
    expect(voucherRow(record()).actions?.map((a) => a.key)).not.toContain("reverseVoucher");
    expect(voucherRow(record({ posting_status: "posted" })).actions?.map((a) => a.key)).toContain("reverseVoucher");
  });
});

describe("validateDraft", () => {
  const balancedLines: DraftLine[] = [
    { line_no: 1, gl_account_id: "gl-101", description: "", debit_won: "50000", credit_won: "" },
    { line_no: 2, gl_account_id: "gl-201", description: "", debit_won: "", credit_won: "50000" },
  ];

  it("balances two well-formed lines", () => {
    const result = validateDraft("월 임대료", balancedLines);
    expect(result.balanced).toBe(true);
    expect(result.totalDebit).toBe(50_000);
    expect(result.totalCredit).toBe(50_000);
  });

  it("rejects an empty title", () => {
    expect(validateDraft("", balancedLines).reasonKey).toBe("console.modules.finance.compose.errors.title");
  });

  it("rejects fewer than two lines", () => {
    expect(validateDraft("t", [balancedLines[0]]).reasonKey).toBe("console.modules.finance.compose.errors.minLines");
  });

  it("rejects an unbalanced total", () => {
    const lines: DraftLine[] = [
      { line_no: 1, gl_account_id: "gl-101", description: "", debit_won: "50000", credit_won: "" },
      { line_no: 2, gl_account_id: "gl-201", description: "", debit_won: "", credit_won: "40000" },
    ];
    expect(validateDraft("t", lines).reasonKey).toBe("console.modules.finance.compose.errors.unbalanced");
  });

  it("rejects a line with both debit and credit populated", () => {
    const lines: DraftLine[] = [
      { line_no: 1, gl_account_id: "gl-101", description: "", debit_won: "10", credit_won: "10" },
      { line_no: 2, gl_account_id: "gl-201", description: "", debit_won: "", credit_won: "10" },
    ];
    expect(validateDraft("t", lines).reasonKey).toBe("console.modules.finance.compose.errors.onesided");
  });
});
