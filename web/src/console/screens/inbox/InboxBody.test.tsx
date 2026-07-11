import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { InboxBody } from "./InboxBody";
import type { InboxApi, InboxDocDetail, InboxDocSummary } from "./inboxApi";
import { inboxStrings } from "./inboxModel";

const S = inboxStrings();

function summary(over: Partial<InboxDocSummary> & Pick<InboxDocSummary, "id" | "kind">): InboxDocSummary {
  return {
    recipient_user_id: "00000000-0000-0000-0000-000000000001",
    title: "문서",
    locked: false,
    created_at: "2026-07-01T00:00:00Z",
    ...over,
  };
}

const payslip = summary({
  id: "11111111-1111-1111-1111-111111111111",
  kind: "payslip",
  title: "2026년 6월 급여명세",
  confirmed_at: null,
});
const lockedNotice = summary({
  id: "22222222-2222-2222-2222-222222222222",
  kind: "legal_notice",
  notice_type: "연차촉진",
  title: "연차 사용 촉진 통지",
  legal_basis: "근로기준법 §61",
  source_id: "AP-3126",
  locked: true,
  confirmed_at: null,
});

function stubApi(over?: Partial<InboxApi>): InboxApi {
  return {
    loadDocs: vi.fn().mockResolvedValue([payslip, lockedNotice]),
    loadDoc: vi.fn((id: string): Promise<InboxDocDetail> =>
      Promise.resolve(
        id === payslip.id
          ? { ...payslip, payload: { paragraphs: ["실지급액 3,120,000원"] } }
          : { ...lockedNotice }, // locked: no payload
      ),
    ),
    confirmReceipt: vi.fn(),
    ...over,
  };
}

function renderBody(api: InboxApi) {
  return render(<InboxBody api={api} />);
}

describe("InboxBody", () => {
  it("lists the vault documents with kind + status chips", async () => {
    renderBody(stubApi());
    await screen.findByText("2026년 6월 급여명세");
    const noticeRow = screen.getByText("연차 사용 촉진 통지").closest("button");
    expect(noticeRow).not.toBeNull();
    // The locked legal notice row carries the 확인 필요 status chip.
    expect(within(noticeRow as HTMLElement).getByText(S.status.locked)).toBeInTheDocument();
  });

  it("opens a readable payslip and renders its payload body", async () => {
    renderBody(stubApi());
    await userEvent.click(await screen.findByText("2026년 6월 급여명세"));
    await screen.findByText("실지급액 3,120,000원");
  });

  it("gates a locked legal notice behind a passkey confirm, then reveals the body", async () => {
    let confirmed = false;
    const confirmedSummary: InboxDocSummary = { ...lockedNotice, locked: false, confirmed_at: "2026-07-11T02:00:00Z" };
    const confirmReceipt = vi.fn(() => {
      confirmed = true;
      return Promise.resolve(confirmedSummary);
    });
    const api = stubApi({
      confirmReceipt,
      loadDoc: vi.fn((id: string): Promise<InboxDocDetail> =>
        Promise.resolve(
          id !== lockedNotice.id
            ? { ...payslip, payload: {} }
            : confirmed
              ? { ...confirmedSummary, payload: { paragraphs: ["연차 잔여 5일 — 사용 시기 지정 통지"] } }
              : { ...lockedNotice },
        ),
      ),
    });

    renderBody(api);
    await userEvent.click(await screen.findByText("연차 사용 촉진 통지"));
    // Locked: body withheld, confirm affordance present.
    const confirmBtn = await screen.findByRole("button", { name: S.detail.confirmButton });
    expect(screen.getByText(S.detail.lockedHint)).toBeInTheDocument();

    await userEvent.click(confirmBtn);

    await screen.findByText("연차 잔여 5일 — 사용 시기 지정 통지");
    expect(confirmReceipt).toHaveBeenCalledWith(lockedNotice.id);
  });

  it("keeps the notice locked and shows an error when the passkey is cancelled", async () => {
    const api = stubApi({
      confirmReceipt: vi.fn().mockRejectedValue(new Error("cancelled")),
    });
    renderBody(api);
    await userEvent.click(await screen.findByText("연차 사용 촉진 통지"));
    await userEvent.click(await screen.findByRole("button", { name: S.detail.confirmButton }));
    await screen.findByText(S.detail.receiptFailed);
    // Still locked — the confirm button remains.
    expect(screen.getByRole("button", { name: S.detail.confirmButton })).toBeInTheDocument();
  });

  it("switches the server-side filter when a tab is clicked", async () => {
    const loadDocs = vi.fn().mockResolvedValue([payslip, lockedNotice]);
    renderBody(stubApi({ loadDocs }));
    await screen.findByText("2026년 6월 급여명세");
    await userEvent.click(screen.getByRole("tab", { name: S.filters.pay }));
    await waitFor(() => {
      expect(loadDocs).toHaveBeenCalledWith("pay");
    });
  });

  it("shows the empty state when the vault has no documents", async () => {
    renderBody(stubApi({ loadDocs: vi.fn().mockResolvedValue([]) }));
    await screen.findByText(S.empty.list);
  });

  it("surfaces a list error with a retry", async () => {
    const api = stubApi({ loadDocs: vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue([payslip]) });
    renderBody(api);
    const alert = await screen.findByRole("alert");
    await userEvent.click(within(alert).getByRole("button", { name: S.retry }));
    await screen.findByText("2026년 6월 급여명세");
  });
});
