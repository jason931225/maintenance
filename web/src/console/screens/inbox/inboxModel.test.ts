import { afterEach, describe, expect, it } from "vitest";

import { ko } from "../../../i18n/ko";
import type { InboxStrings } from "./inboxModel";
import { inboxStrings } from "./inboxModel";

const consoleStrings = ko.console as unknown as {
  inboxVault?: Partial<InboxStrings> & {
    filters?: Partial<InboxStrings["filters"]>;
    status?: Partial<InboxStrings["status"]>;
    kind?: Partial<InboxStrings["kind"]>;
    detail?: Partial<InboxStrings["detail"]>;
    empty?: Partial<InboxStrings["empty"]>;
  };
};
const originalInboxStrings = consoleStrings.inboxVault;

afterEach(() => {
  consoleStrings.inboxVault = originalInboxStrings;
});

describe("inboxStrings", () => {
  it("deep-merges partial nested translation groups with safe fallbacks", () => {
    consoleStrings.inboxVault = {
      filters: { pay: "Custom pay" },
      status: { locked: "Custom locked" },
      kind: { payslip: "Custom payslip" },
      detail: { lockedTitle: "Custom detail" },
      empty: { list: "Custom empty" },
    };

    const strings = inboxStrings();

    expect(strings.filters.pay).toBe("Custom pay");
    expect(strings.filters.all).toBeTypeOf("string");
    expect(strings.status.locked).toBe("Custom locked");
    expect(strings.status.confirmed("date")).toContain("date");
    expect(strings.kind.payslip).toBe("Custom payslip");
    expect(strings.kind.legal_notice).toBeTypeOf("string");
    expect(strings.detail.lockedTitle).toBe("Custom detail");
    expect(strings.detail.confirmedAt("date")).toContain("date");
    expect(strings.empty.list).toBe("Custom empty");
    expect(strings.empty.selection).toBeTypeOf("string");
  });
});
