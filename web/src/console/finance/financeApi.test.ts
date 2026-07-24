import { describe, expect, it } from "vitest";

import {
  FinanceAccountDrillContractError,
  parseAccountDrillEntries,
  type AccountDrillEntry,
} from "./financeApi";

const entry: AccountDrillEntry = {
  voucher_id: "11111111-1111-4111-8111-111111111111",
  voucher_no: "VC-1001",
  status: "POSTED",
  line_id: "22222222-2222-4222-8222-222222222222",
  account_code: "101",
  side: "DEBIT",
  amount_won: 500_000,
  source_object_type: "purchase_request",
  source_object_id: "pr-1",
  entry_at: "2026-07-09T00:00:00Z",
};

describe("parseAccountDrillEntries", () => {
  it("accepts the generated account-drill DTO only when every required identity and amount field is present", () => {
    expect(parseAccountDrillEntries([entry])).toEqual([entry]);
  });

  it("fails closed when a 2xx payload is missing a source identity field", () => {
    expect(() => parseAccountDrillEntries([{ ...entry, source_object_id: null }])).toThrow(
      FinanceAccountDrillContractError,
    );
  });

  it("fails closed for an unrecognized debit-credit side instead of rendering a fabricated classification", () => {
    expect(() => parseAccountDrillEntries([{ ...entry, side: "BOTH" }])).toThrow(
      FinanceAccountDrillContractError,
    );
  });

  it.each([
    ["fractional won amount", { amount_won: 500_000.5 }],
    ["unsafe won amount", { amount_won: Number.MAX_SAFE_INTEGER + 1 }],
    ["non-UUID voucher identity", { voucher_id: "v-1" }],
    ["non-UUID line identity", { line_id: "line-1" }],
    ["non-RFC3339 entry timestamp", { entry_at: "2026-07-09" }],
    ["impossible RFC3339 calendar timestamp", { entry_at: "2026-02-30T00:00:00Z" }],
  ])("fails closed for a %s", (_case, invalidFields) => {
    expect(() => parseAccountDrillEntries([{ ...entry, ...invalidFields }])).toThrow(
      FinanceAccountDrillContractError,
    );
  });
});
