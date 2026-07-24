import { describe, expect, it } from "vitest";

import {
  FinanceAccountDrillContractError,
  parseAccountDrillEntries,
  type AccountDrillEntry,
} from "./financeApi";

const entry: AccountDrillEntry = {
  voucher_id: "v-1",
  voucher_no: "VC-1001",
  status: "POSTED",
  line_id: "line-1",
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
});
