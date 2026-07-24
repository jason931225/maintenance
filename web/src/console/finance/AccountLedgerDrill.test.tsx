import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../../api/client";
import { ApiCallError } from "../../api/ontologyActions";
import { ko } from "../../i18n/ko";
import { AccountLedgerDrill } from "./AccountLedgerDrill";

const copy = ko.console.modules.finance.accountLedger;
const entry = {
  voucher_id: "11111111-1111-4111-8111-111111111111",
  voucher_no: "VC-CURRENT",
  status: "POSTED" as const,
  line_id: "22222222-2222-4222-8222-222222222222",
  account_code: "101",
  side: "DEBIT" as const,
  amount_won: 500_000,
  source_object_type: "purchase_request",
  source_object_id: "pr-current",
  entry_at: "2026-07-09T00:00:00Z",
};

function signalFromOptions(value: unknown): AbortSignal {
  if (
    typeof value !== "object" ||
    value === null ||
    !("signal" in value) ||
    !(value.signal instanceof AbortSignal)
  ) {
    throw new Error("account-ledger request did not receive an AbortSignal");
  }
  return value.signal;
}

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

  it("retries a recoverable failure with a new request, aborting the failed request and rendering its real result", async () => {
    const api = createConsoleApiClient("account-ledger-test-token");
    const get = vi.spyOn(api, "GET")
      .mockImplementationOnce(() => Promise.reject(new ApiCallError(500)))
      .mockImplementationOnce(() => Promise.resolve({ data: [entry] }));
    render(<AccountLedgerDrill api={api} accountCode="101" onClose={() => {}} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(copy.failed);
    const failedRequestSignal = signalFromOptions(get.mock.calls[0]?.[1]);
    await userEvent.click(screen.getByRole("button", { name: ko.page.retry }));

    expect(await screen.findByText("VC-CURRENT")).toBeVisible();
    expect(get).toHaveBeenCalledTimes(2);
    expect(failedRequestSignal.aborted).toBe(true);
  });

  it("aborts the active request before delegating close to its parent", async () => {
    const api = createConsoleApiClient("account-ledger-test-token");
    const get = vi.spyOn(api, "GET").mockImplementation(() => new Promise(() => {}));
    const onClose = vi.fn();
    render(<AccountLedgerDrill api={api} accountCode="101" onClose={onClose} />);
    await waitFor(() => {
      expect(get).toHaveBeenCalledTimes(1);
    });
    const signal = signalFromOptions(get.mock.calls[0]?.[1]);

    await userEvent.click(screen.getByRole("button", { name: copy.close }));

    expect(signal.aborted).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("aborts the active request when its parent unmounts the drill", async () => {
    const api = createConsoleApiClient("account-ledger-test-token");
    const get = vi.spyOn(api, "GET").mockImplementation(() => new Promise(() => {}));
    const view = render(<AccountLedgerDrill api={api} accountCode="101" onClose={() => {}} />);
    await waitFor(() => {
      expect(get).toHaveBeenCalledTimes(1);
    });
    const signal = signalFromOptions(get.mock.calls[0]?.[1]);

    view.unmount();

    expect(signal.aborted).toBe(true);
  });
});
