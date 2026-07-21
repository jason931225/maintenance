import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { InboxBody } from "./InboxBody";
import type { InboxApi, InboxDocDetail, InboxDocSummary } from "./inboxApi";
import { inboxStrings } from "./inboxModel";

const S = inboxStrings();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

  it("does not let a receipt confirmation overwrite a newly selected document", async () => {
    const confirmation = deferred<InboxDocSummary>();
    const confirmedSummary: InboxDocSummary = {
      ...lockedNotice,
      locked: false,
      confirmed_at: "2026-07-11T02:00:00Z",
    };
    const loadDoc = vi.fn((id: string): Promise<InboxDocDetail> =>
      Promise.resolve(
        id === payslip.id
          ? { ...payslip, payload: { paragraphs: ["선택한 급여명세"] } }
          : { ...lockedNotice },
      ),
    );
    renderBody(
      stubApi({
        confirmReceipt: vi.fn(() => confirmation.promise),
        loadDoc,
      }),
    );

    await userEvent.click(await screen.findByText("연차 사용 촉진 통지"));
    await userEvent.click(await screen.findByRole("button", { name: S.detail.confirmButton }));
    await userEvent.click(screen.getByText("2026년 6월 급여명세"));
    expect(await screen.findByText("선택한 급여명세")).toBeVisible();

    await act(async () => {
      confirmation.resolve(confirmedSummary);
      await confirmation.promise;
    });
    await waitFor(() => {
      expect(screen.getByText("선택한 급여명세")).toBeVisible();
      expect(screen.queryByText(S.detail.receiptFailed)).not.toBeInTheDocument();
    });
  });

  it("shows a document-load error, not a passkey error, after receipt confirmation succeeds", async () => {
    const confirmedSummary: InboxDocSummary = {
      ...lockedNotice,
      locked: false,
      confirmed_at: "2026-07-11T02:00:00Z",
    };
    const loadDoc = vi
      .fn()
      .mockResolvedValueOnce({ ...lockedNotice })
      .mockRejectedValueOnce(new Error("reload failed"));
    renderBody(
      stubApi({
        confirmReceipt: vi.fn().mockResolvedValue(confirmedSummary),
        loadDoc,
      }),
    );

    await userEvent.click(await screen.findByText("연차 사용 촉진 통지"));
    await userEvent.click(await screen.findByRole("button", { name: S.detail.confirmButton }));

    expect(await screen.findByText(S.error)).toBeVisible();
    expect(screen.queryByText(S.detail.receiptFailed)).not.toBeInTheDocument();
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

  it("ignores a retired pagination result after the filter changes", async () => {
    const retiredPage = deferred<InboxDocSummary[]>();
    const activeDoc = summary({
      id: "33333333-3333-3333-3333-333333333333",
      kind: "payslip",
      title: "현재 필터 문서",
    });
    const loadDocs = vi.fn((filter: string) =>
      filter === "all" ? retiredPage.promise : Promise.resolve([activeDoc]),
    );
    renderBody(stubApi({ loadDocs }));

    await userEvent.click(screen.getByRole("tab", { name: S.filters.pay }));
    expect(await screen.findByText("현재 필터 문서")).toBeVisible();

    await act(async () => {
      retiredPage.resolve([
        summary({
          id: "44444444-4444-4444-4444-444444444444",
          kind: "legal_notice",
          title: "폐기된 이전 페이지",
        }),
      ]);
      await retiredPage.promise;
    });

    await waitFor(() => {
      expect(screen.getByText("현재 필터 문서")).toBeVisible();
      expect(screen.queryByText("폐기된 이전 페이지")).not.toBeInTheDocument();
    });
  });

  it("clears a selected detail when the server-side filter changes", async () => {
    renderBody(stubApi());
    await userEvent.click(await screen.findByText("2026년 6월 급여명세"));
    expect(await screen.findByText("실지급액 3,120,000원")).toBeVisible();

    await userEvent.click(screen.getByRole("tab", { name: S.filters.pay }));
    expect(screen.getByText(S.empty.selection)).toBeVisible();
    expect(screen.queryByText("실지급액 3,120,000원")).not.toBeInTheDocument();
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

  it("synchronously withholds prior-api list and detail state", async () => {
    const apiA = stubApi({
      loadDocs: vi.fn().mockResolvedValue([payslip]),
      loadDoc: vi.fn().mockResolvedValue({
        ...payslip,
        payload: { paragraphs: ["TENANT A PAYSLIP"] },
      }),
    });
    const nextDocs = deferred<InboxDocSummary[]>();
    const apiB = stubApi({
      loadDocs: vi.fn(() => nextDocs.promise),
      loadDoc: vi.fn().mockResolvedValue({
        ...payslip,
        title: "테넌트 B 문서",
        payload: { paragraphs: ["TENANT B PAYSLIP"] },
      }),
    });
    const view = renderBody(apiA);

    await userEvent.click(await screen.findByText("2026년 6월 급여명세"));
    expect(await screen.findByText("TENANT A PAYSLIP")).toBeVisible();

    view.rerender(<InboxBody api={apiB} />);

    expect(screen.queryAllByText("2026년 6월 급여명세")).toHaveLength(0);
    expect(screen.queryByText("TENANT A PAYSLIP")).not.toBeInTheDocument();
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);

    await act(async () => {
      nextDocs.resolve([]);
      await nextDocs.promise;
    });
  });

  it("rejects an old-api confirmation before list update or detail reload", async () => {
    const confirmation = deferred<InboxDocSummary>();
    const apiASummary = { ...lockedNotice, title: "테넌트 A 통지" };
    const apiAConfirmed = {
      ...apiASummary,
      locked: false,
      confirmed_at: "2026-07-11T02:00:00Z",
      title: "테넌트 A 확인 완료",
    };
    const apiALoadDoc = vi
      .fn<(id: string) => Promise<InboxDocDetail>>()
      .mockResolvedValueOnce({ ...apiASummary })
      .mockResolvedValueOnce({
        ...apiAConfirmed,
        payload: { paragraphs: ["TENANT A SECRET"] },
      });
    const apiA = stubApi({
      loadDocs: vi.fn().mockResolvedValue([apiASummary]),
      loadDoc: apiALoadDoc,
      confirmReceipt: vi.fn(() => confirmation.promise),
    });
    const apiBSummary = { ...lockedNotice, title: "테넌트 B 통지" };
    const apiBLoadDoc = vi.fn().mockResolvedValue({ ...apiBSummary });
    const apiB = stubApi({
      loadDocs: vi.fn().mockResolvedValue([apiBSummary]),
      loadDoc: apiBLoadDoc,
    });
    const view = renderBody(apiA);

    await userEvent.click(await screen.findByText("테넌트 A 통지"));
    await userEvent.click(await screen.findByRole("button", { name: S.detail.confirmButton }));

    view.rerender(<InboxBody api={apiB} />);
    expect((await screen.findAllByText("테넌트 B 통지")).length).toBeGreaterThan(0);

    await act(async () => {
      confirmation.resolve(apiAConfirmed);
      await confirmation.promise;
    });

    await waitFor(() => {
      expect(screen.getByText("테넌트 B 통지")).toBeVisible();
      expect(screen.queryByText("테넌트 A 확인 완료")).not.toBeInTheDocument();
      expect(screen.queryByText("TENANT A SECRET")).not.toBeInTheDocument();
    });
    expect(apiALoadDoc).toHaveBeenCalledTimes(1);
    expect(apiBLoadDoc).not.toHaveBeenCalled();
  });
});
