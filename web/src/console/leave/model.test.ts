import { describe, expect, it } from "vitest";

import type { LeaveRosterEntry } from "../../api/types";
import { rosterToLedgerRow } from "./model";

function entry(employee_id: string, name: string): LeaveRosterEntry {
  return { employee_id, name, team: "정비팀", grant: 15, used: 4, left: 11, tone: "ok" };
}

describe("rosterToLedgerRow", () => {
  // Regression: native employee UUIDs share a long all-zero prefix, so slicing
  // the head BEFORE stripping leading zeros collapsed every roster row's code
  // to "LV-000000" (verdict R10). Distinct employees must get distinct codes.
  it("derives a distinct code per zero-prefixed employee id", () => {
    const a = rosterToLedgerRow(entry("00000000-0000-0000-0000-000000ee0001", "김정비"));
    const b = rosterToLedgerRow(entry("00000000-0000-0000-0000-000000ee0002", "박접수"));
    const c = rosterToLedgerRow(entry("00000000-0000-0000-0000-000000ee0012", "문가온"));

    expect(a.code).toBe("LV-EE0001");
    expect(b.code).toBe("LV-EE0002");
    expect(c.code).toBe("LV-EE0012");
    expect(new Set([a.code, b.code, c.code]).size).toBe(3);
  });

  it("carries the roster's real balances and name through", () => {
    const row = rosterToLedgerRow(entry("00000000-0000-0000-0000-000000ee0009", "임하늘"));
    expect(row).toMatchObject({ name: "임하늘", accrued: 15, used: 4, remaining: 11, active: true });
  });
});
