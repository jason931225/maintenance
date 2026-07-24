import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../../api/client";
import { ApiCallError } from "../../api/ontologyActions";
import { ko } from "../../i18n/ko";
import { AccountLedgerDrill } from "./AccountLedgerDrill";

const copy = ko.console.modules.finance.accountLedger;

function renderDrill(status: number) {
  const api = createConsoleApiClient("account-ledger-test-token");
  vi.spyOn(api, "GET").mockImplementation(() => Promise.reject(new ApiCallError(status)));
  return render(<AccountLedgerDrill api={api} accountCode="101" onClose={() => {}} />);
}

describe("AccountLedgerDrill", () => {
  it("renders the backend authorization denial without offering a futile retry", async () => {
    renderDrill(403);

    expect(await screen.findByRole("alert")).toHaveTextContent(copy.denied);
    expect(screen.queryByRole("button", { name: ko.page.retry })).not.toBeInTheDocument();
  });

  it("renders an operational error with a retry control", async () => {
    renderDrill(500);

    expect(await screen.findByRole("alert")).toHaveTextContent(copy.failed);
    expect(screen.getByRole("button", { name: ko.page.retry })).toBeEnabled();
  });
});
