import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { salesCrm as S } from "../../i18n/salesCrm";
import { SalesCrmScreen } from "./SalesCrmScreen";
import { canAccessSales } from "./salesAccess";

const listing = {
  id: "11111111-1111-1111-1111-111111111111",
  equipment_id: null,
  kind: "ELECTRIC",
  condition: "USED",
  model_name: "E20 전동 지게차",
  capacity_milli: 2000,
  model_year: 2024,
  usage_hours: 14,
  price_won: 32000000,
  badge: null,
  usage_label: null,
  condition_label: null,
  availability: "판매 가능",
  location: "평택",
  description: null,
  listing_type: "SALE",
  status: "PUBLISHED",
  sort_weight: 0,
  created_at: "2026-07-20T10:00:00Z",
  updated_at: "2026-07-20T10:00:00Z",
  media: [],
} as const;

const inquiry = {
  id: "22222222-2222-2222-2222-222222222222",
  name: "김민수",
  phone: "010-0000-0000",
  topic: "USED_SALES",
  location: "평택",
  message: "현장 투입 가능 일정을 확인하고 싶습니다.",
  listing_id: listing.id,
  status: "NEW",
  created_at: "2026-07-21T10:00:00Z",
  updated_at: "2026-07-21T10:00:00Z",
} as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function api({ denied = false, reject = false }: { denied?: boolean; reject?: boolean } = {}) {
  const GET = vi.fn((path: string) => {
    if (denied) return Promise.resolve({ response: new Response(null, { status: 403 }), error: { message: "forbidden" } });
    if (reject) return Promise.resolve({ response: new Response(null, { status: 500 }), error: { message: "failed" } });
    if (path === "/api/v1/sales/listings") return Promise.resolve({ response: new Response(), data: { items: [listing], limit: 50, offset: 0, total: 1 } });
    return Promise.resolve({ response: new Response(), data: { items: [inquiry], limit: 50, offset: 0, total: 1 } });
  });
  const PATCH = vi.fn(() => Promise.resolve({ response: new Response(null, { status: 204 }) }));
  return { GET, PATCH } as unknown as ConsoleApiClient;
}

describe("SalesCrmScreen", () => {
  it("includes backend-authorized executives in the sales body hint", () => {
    expect(canAccessSales(["EXECUTIVE"], [])).toBe(true);
    expect(canAccessSales(["MEMBER"], [])).toBe(false);
  });

  it("keeps every visible sales literal in the module copy resource", () => {
    expect([S.kindLpg, S.catalogKicker, S.inboxKicker, S.detailKicker]).toEqual([
      "LPG", "SALES CATALOG", "INQUIRY INBOX", "INQUIRY DETAIL",
    ]);
  });
  it("shows authenticated catalog and inbound inquiry detail without inventing a customer master", async () => {
    render(<SalesCrmScreen api={api()} />);
    expect(await screen.findByText("E20 전동 지게차")).toBeVisible();
    expect(screen.getByRole("option", { name: /김민수/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("현장 투입 가능 일정을 확인하고 싶습니다.")).toBeVisible();
    expect(screen.queryByText("고객 마스터")).not.toBeInTheDocument();
  });

  it("transitions a selected inquiry only through the real status endpoint", async () => {
    const client = api();
    let committed = false;
    vi.mocked(client.GET).mockImplementation((path: string) => Promise.resolve(path === "/api/v1/sales/listings"
      ? ({ response: new Response(), data: { items: [listing], limit: 50, offset: 0, total: 1 } } as never)
      : ({ response: new Response(), data: { items: [{ ...inquiry, status: committed ? "CONTACTED" : "NEW" }], limit: 50, offset: 0, total: 1 } } as never)));
    vi.mocked(client.PATCH).mockImplementation(() => {
      committed = true;
      return Promise.resolve({ response: new Response(null, { status: 204 }) } as never);
    });
    render(<SalesCrmScreen api={client} />);
    await screen.findByRole("option", { name: /김민수/ });
    fireEvent.click(screen.getByRole("button", { name: "연락 완료로 변경" }));
    await waitFor(() => {
      expect(client.PATCH).toHaveBeenCalledWith(
        "/api/v1/sales/inquiries/{id}",
        expect.objectContaining({ params: { path: { id: inquiry.id } }, body: { status: "CONTACTED" } }),
      );
    });
    expect(await screen.findByRole("button", { name: "종료로 변경" })).toBeVisible();
  });

  it("does not let a pre-mutation inquiry snapshot overwrite a committed status", async () => {
    const staleSnapshot = deferred<unknown>();
    let inquiryCalls = 0;
    const client = api();
    vi.mocked(client.GET).mockImplementation((path: string) => {
      if (path === "/api/v1/sales/listings") {
        return Promise.resolve({ response: new Response(), data: { items: [listing], limit: 50, offset: 0, total: 1 } } as never);
      }
      inquiryCalls += 1;
      if (inquiryCalls === 2) return staleSnapshot.promise;
      return Promise.resolve({ response: new Response(), data: { items: [{ ...inquiry, status: inquiryCalls === 3 ? "CONTACTED" : "NEW" }], limit: 50, offset: 0, total: 1 } } as never);
    });
    render(<SalesCrmScreen api={client} />);
    await screen.findByRole("button", { name: "연락 완료로 변경" });
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    fireEvent.click(screen.getByRole("button", { name: "연락 완료로 변경" }));
    await waitFor(() => { expect(client.PATCH).toHaveBeenCalledTimes(1); });
    expect(await screen.findByRole("button", { name: "종료로 변경" })).toBeVisible();
    await act(async () => {
      staleSnapshot.resolve({ response: new Response(), data: { items: [inquiry], limit: 50, offset: 0, total: 1 } });
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "종료로 변경" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "연락 완료로 변경" })).not.toBeInTheDocument();
    expect(inquiryCalls).toBe(3);
  });

  it("reconciles the current filter after a mutation without admitting its stale filtered read", async () => {
    const patch = deferred<unknown>();
    const staleFilteredRead = deferred<unknown>();
    let inquiryCalls = 0;
    const client = api();
    vi.mocked(client.GET).mockImplementation((path: string) => {
      if (path === "/api/v1/sales/listings") return Promise.resolve({ response: new Response(), data: { items: [listing], limit: 50, offset: 0, total: 1 } } as never);
      inquiryCalls += 1;
      if (inquiryCalls === 2) return staleFilteredRead.promise;
      return Promise.resolve({ response: new Response(), data: { items: [{ ...inquiry, status: inquiryCalls === 3 ? "CONTACTED" : "NEW" }], limit: 50, offset: 0, total: 1 } } as never);
    });
    vi.mocked(client.PATCH).mockImplementation(() => patch.promise);
    render(<SalesCrmScreen api={client} />);
    await screen.findByRole("button", { name: "연락 완료로 변경" });
    fireEvent.click(screen.getByRole("button", { name: "연락 완료로 변경" }));
    fireEvent.click(screen.getByRole("button", { name: "신규" }));
    await act(async () => {
      patch.resolve({ response: new Response(null, { status: 204 }) });
      await Promise.resolve();
    });
    expect(await screen.findByRole("button", { name: "종료로 변경" })).toBeVisible();
    const inquiryCallsAfterMutation = vi.mocked(client.GET).mock.calls.filter(
      ([path]) => path === "/api/v1/sales/inquiries",
    );
    const reconciliation =
      inquiryCallsAfterMutation[inquiryCallsAfterMutation.length - 1];
    expect(reconciliation[1]).toEqual(expect.objectContaining({
      headers: { "Cache-Control": "no-cache" },
      params: { query: expect.objectContaining({ status: "NEW" }) },
    }));
    await act(async () => {
      staleFilteredRead.resolve({ response: new Response(), data: { items: [inquiry], limit: 50, offset: 0, total: 1 } });
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "종료로 변경" })).toBeVisible();
  });

  it("keeps PATCH authorization denial fail-closed when an in-flight GET succeeds", async () => {
    const inFlightRead = deferred<unknown>();
    let inquiryCalls = 0;
    const client = api();
    vi.mocked(client.GET).mockImplementation((path: string) => {
      if (path === "/api/v1/sales/listings") return Promise.resolve({ response: new Response(), data: { items: [listing], limit: 50, offset: 0, total: 1 } } as never);
      inquiryCalls += 1;
      if (inquiryCalls === 2) return inFlightRead.promise;
      return Promise.resolve({ response: new Response(), data: { items: [inquiry], limit: 50, offset: 0, total: 1 } } as never);
    });
    vi.mocked(client.PATCH).mockImplementation(() => Promise.resolve({ response: new Response(null, { status: 403 }), error: { message: "forbidden" } } as never));
    render(<SalesCrmScreen api={client} />);
    await screen.findByRole("button", { name: "연락 완료로 변경" });
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    fireEvent.click(screen.getByRole("button", { name: "연락 완료로 변경" }));
    expect(await screen.findByText("판매 관리 권한이 없습니다.")).toBeVisible();
    await act(async () => {
      inFlightRead.resolve({ response: new Response(), data: { items: [inquiry], limit: 50, offset: 0, total: 1 } });
      await Promise.resolve();
    });
    expect(screen.getByText("판매 관리 권한이 없습니다.")).toBeVisible();
    expect(inquiryCalls).toBe(2);
  });

  it("latches a stale GET denial even after a newer GET succeeds", async () => {
    const staleDeniedRead = deferred<unknown>();
    let inquiryCalls = 0;
    const client = api();
    vi.mocked(client.GET).mockImplementation((path: string) => {
      if (path === "/api/v1/sales/listings") return Promise.resolve({ response: new Response(), data: { items: [listing], limit: 50, offset: 0, total: 1 } } as never);
      inquiryCalls += 1;
      if (inquiryCalls === 2) return staleDeniedRead.promise;
      return Promise.resolve({ response: new Response(), data: { items: [inquiry], limit: 50, offset: 0, total: 1 } } as never);
    });
    render(<SalesCrmScreen api={client} />);
    await screen.findByRole("button", { name: "새로고침" });
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => { expect(inquiryCalls).toBe(3); });
    await act(async () => {
      staleDeniedRead.resolve({ response: new Response(null, { status: 403 }), error: { message: "forbidden" } });
      await Promise.resolve();
    });
    expect(await screen.findByText("판매 관리 권한이 없습니다.")).toBeVisible();
  });

  it.each([
    "/api/v1/sales/listings",
    "/api/v1/sales/inquiries",
  ] as const)("does not let a replaced API client's late 403 deny the current view (%s)", async (deniedPath) => {
    const oldDeniedRead = deferred<unknown>();
    const apiA = api();
    const apiB = api();
    const currentListing = { ...listing, model_name: "E35 최신 전동 지게차" };
    const currentInquiry = { ...inquiry, name: "새 세션 고객" };
    vi.mocked(apiA.GET).mockImplementation((path: string) =>
      path === deniedPath ? oldDeniedRead.promise : new Promise(() => {}),
    );
    vi.mocked(apiB.GET).mockImplementation((path: string) => Promise.resolve(
      path === "/api/v1/sales/listings"
        ? ({ response: new Response(), data: { items: [currentListing], limit: 50, offset: 0, total: 1 } } as never)
        : ({ response: new Response(), data: { items: [currentInquiry], limit: 50, offset: 0, total: 1 } } as never),
    ));

    const view = render(<SalesCrmScreen api={apiA} />);
    await waitFor(() => { expect(apiA.GET).toHaveBeenCalledTimes(2); });
    view.rerender(<SalesCrmScreen api={apiB} />);
    expect(await screen.findByText("E35 최신 전동 지게차")).toBeVisible();
    expect(await screen.findByRole("option", { name: /새 세션 고객/ })).toBeVisible();

    await act(async () => {
      oldDeniedRead.resolve({ response: new Response(null, { status: 403 }), error: { message: "forbidden" } });
      await Promise.resolve();
    });

    expect(screen.queryByText("판매 관리 권한이 없습니다.")).not.toBeInTheDocument();
    expect(screen.getByText("E35 최신 전동 지게차")).toBeVisible();
    expect(screen.getByRole("option", { name: /새 세션 고객/ })).toBeVisible();
  });

  it("does not let a GET rejection overwrite a PATCH denial", async () => {
    const rejectedRead = deferred<unknown>();
    let inquiryCalls = 0;
    const client = api();
    vi.mocked(client.GET).mockImplementation((path: string) => {
      if (path === "/api/v1/sales/listings") return Promise.resolve({ response: new Response(), data: { items: [listing], limit: 50, offset: 0, total: 1 } } as never);
      inquiryCalls += 1;
      if (inquiryCalls === 2) return rejectedRead.promise;
      return Promise.resolve({ response: new Response(), data: { items: [inquiry], limit: 50, offset: 0, total: 1 } } as never);
    });
    vi.mocked(client.PATCH).mockImplementation(() => Promise.resolve({ response: new Response(null, { status: 403 }), error: { message: "forbidden" } } as never));
    render(<SalesCrmScreen api={client} />);
    await screen.findByRole("button", { name: "연락 완료로 변경" });
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    fireEvent.click(screen.getByRole("button", { name: "연락 완료로 변경" }));
    expect(await screen.findByText("판매 관리 권한이 없습니다.")).toBeVisible();
    await act(async () => {
      rejectedRead.reject(new Error("offline"));
      await Promise.resolve();
    });
    expect(screen.getByText("판매 관리 권한이 없습니다.")).toBeVisible();
  });

  it("does not let an old API mutation write or reconcile after an API rerender", async () => {
    const oldPatch = deferred<unknown>();
    const newPatch = deferred<unknown>();
    const apiA = api();
    const apiB = api();
    let apiBCommitted = false;
    vi.mocked(apiA.PATCH).mockImplementation(() => oldPatch.promise);
    vi.mocked(apiB.GET).mockImplementation((path: string) => Promise.resolve(path === "/api/v1/sales/listings"
      ? ({ response: new Response(), data: { items: [listing], limit: 50, offset: 0, total: 1 } } as never)
      : ({ response: new Response(), data: { items: [{ ...inquiry, status: apiBCommitted ? "CONTACTED" : "NEW" }], limit: 50, offset: 0, total: 1 } } as never)));
    vi.mocked(apiB.PATCH).mockImplementation(() => newPatch.promise);
    const view = render(<SalesCrmScreen api={apiA} />);
    await screen.findByRole("button", { name: "연락 완료로 변경" });
    fireEvent.click(screen.getByRole("button", { name: "연락 완료로 변경" }));
    view.rerender(<SalesCrmScreen api={apiB} />);
    const apiBTransition = await screen.findByRole("button", { name: "연락 완료로 변경" });
    expect(apiBTransition).toBeEnabled();
    fireEvent.click(apiBTransition);
    await waitFor(() => { expect(vi.mocked(apiB.PATCH)).toHaveBeenCalledTimes(1); });
    expect(vi.mocked(apiA.PATCH)).toHaveBeenCalledTimes(1);
    await act(async () => {
      oldPatch.resolve({ response: new Response(null, { status: 204 }) });
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "상태 변경 중…" })).toBeDisabled();
    expect(vi.mocked(apiB.PATCH)).toHaveBeenCalledTimes(1);
    apiBCommitted = true;
    await act(async () => {
      newPatch.resolve({ response: new Response(null, { status: 204 }) });
      await Promise.resolve();
    });
    expect(await screen.findByRole("button", { name: "종료로 변경" })).toBeVisible();
    expect(vi.mocked(apiA.GET)).toHaveBeenCalledTimes(2);
  });

  it("cancels an initial refresh scheduled for an immediately unmounted view", async () => {
    const abandoned = api();
    const abandonedView = render(<SalesCrmScreen api={abandoned} />);
    abandonedView.unmount();
    await act(() => Promise.resolve());
    expect(abandoned.GET).not.toHaveBeenCalled();
    const replay = api();
    render(<SalesCrmScreen api={replay} />);
    expect(await screen.findByRole("option", { name: /김민수/ })).toBeVisible();
    expect(replay.GET).toHaveBeenCalledTimes(2);
  });

  it("keeps keyboard inquiry navigation within the authenticated inbox", async () => {
    const second = { ...inquiry, id: "33333333-3333-3333-3333-333333333333", name: "이서연", status: "CONTACTED" as const };
    const third = { ...inquiry, id: "55555555-5555-5555-5555-555555555555", name: "최도윤", status: "CLOSED" as const };
    const client = api();
    vi.mocked(client.GET).mockImplementation((path: string) => Promise.resolve(path === "/api/v1/sales/listings"
      ? ({ response: new Response(), data: { items: [listing], limit: 50, offset: 0, total: 1 } } as never)
      : ({ response: new Response(), data: { items: [inquiry, second, third], limit: 50, offset: 0, total: 3 } } as never)));
    render(<SalesCrmScreen api={client} />);
    const first = await screen.findByRole("option", { name: /김민수/ });
    fireEvent.keyDown(first, { key: "ArrowDown" });
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /이서연/ })).toHaveAttribute("aria-selected", "true");
    });
    expect(screen.getByRole("option", { name: /이서연/ })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("option", { name: /이서연/ }), { key: "End" });
    await waitFor(() => { expect(screen.getByRole("option", { name: /최도윤/ })).toHaveFocus(); });
    fireEvent.keyDown(screen.getByRole("option", { name: /최도윤/ }), { key: "Home" });
    await waitFor(() => { expect(first).toHaveFocus(); });
    expect(screen.getByRole("listbox")).not.toHaveAttribute("aria-activedescendant");
  });

  it("renders denied and independent retryable failure states truthfully", async () => {
    const deniedView = render(<SalesCrmScreen api={api({ denied: true })} />);
    expect(await screen.findByText("판매 관리 권한이 없습니다.")).toBeVisible();
    deniedView.unmount();
    render(<SalesCrmScreen api={api({ reject: true })} />);
    expect(await screen.findAllByRole("button", { name: "다시 시도" })).toHaveLength(2);
  });

  it("keeps a successful inbox visible when the catalog request fails", async () => {
    const client = api();
    vi.mocked(client.GET).mockImplementation((path: string) => Promise.resolve(path === "/api/v1/sales/listings"
      ? ({ response: new Response(null, { status: 500 }), error: { message: "catalog failed" } } as never)
      : ({ response: new Response(), data: { items: [inquiry], limit: 50, offset: 0, total: 1 } } as never)));
    render(<SalesCrmScreen api={client} />);
    expect(await screen.findByText("판매 목록을 불러오지 못했습니다.")).toBeVisible();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeVisible();
    expect(screen.getByRole("option", { name: /김민수/ })).toBeVisible();
    expect(screen.getByText("현장 투입 가능 일정을 확인하고 싶습니다.")).toBeVisible();
  });

  it("labels retained catalog rows as stale when a later refresh fails", async () => {
    let catalogCalls = 0;
    const client = api();
    vi.mocked(client.GET).mockImplementation((path: string) => {
      if (path === "/api/v1/sales/listings") {
        catalogCalls += 1;
        return Promise.resolve(catalogCalls === 1
          ? ({ response: new Response(), data: { items: [listing], limit: 50, offset: 0, total: 1 } } as never)
          : ({ response: new Response(null, { status: 500 }), error: { message: "catalog refresh failed" } } as never));
      }
      return Promise.resolve({ response: new Response(), data: { items: [inquiry], limit: 50, offset: 0, total: 1 } } as never);
    });
    render(<SalesCrmScreen api={client} />);
    expect(await screen.findByText("E20 전동 지게차")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    expect(await screen.findByText("판매 목록 최신 정보를 확인하지 못했습니다. 아래 목록은 이전 조회 결과입니다.")).toBeVisible();
    expect(screen.getByText("E20 전동 지게차")).toBeVisible();
    expect(screen.getAllByRole("button", { name: "다시 시도" })).toHaveLength(1);
  });

  it("fails closed when either stream is denied despite a sibling success in either response order", async () => {
    for (const deniedPath of ["/api/v1/sales/listings", "/api/v1/sales/inquiries"] as const) {
      for (const denyFirst of [true, false]) {
        const catalogResult = deferred<unknown>();
        const inboxResult = deferred<unknown>();
        const client = api();
        vi.mocked(client.GET).mockImplementation((path: string) => path === "/api/v1/sales/listings" ? catalogResult.promise : inboxResult.promise);
        const view = render(<SalesCrmScreen api={client} />);
        const denied = { response: new Response(null, { status: 403 }), error: { message: "forbidden" } } as never;
        const catalogSuccess = { response: new Response(), data: { items: [listing], limit: 50, offset: 0, total: 1 } } as never;
        const inboxSuccess = { response: new Response(), data: { items: [inquiry], limit: 50, offset: 0, total: 1 } } as never;
        const first = deniedPath === "/api/v1/sales/listings" ? (denyFirst ? catalogResult : inboxResult) : (denyFirst ? inboxResult : catalogResult);
        const second = deniedPath === "/api/v1/sales/listings" ? (denyFirst ? inboxResult : catalogResult) : (denyFirst ? catalogResult : inboxResult);
        await act(async () => {
          first.resolve(denyFirst ? denied : (first === catalogResult ? catalogSuccess : inboxSuccess));
          await Promise.resolve();
        });
        if (!denyFirst) {
          if (deniedPath === "/api/v1/sales/listings") expect(await screen.findByRole("option", { name: /김민수/ })).toBeVisible();
          else expect(await screen.findByText("E20 전동 지게차")).toBeVisible();
        }
        await act(async () => {
          second.resolve(denyFirst ? (second === catalogResult ? catalogSuccess : inboxSuccess) : denied);
          await Promise.resolve();
        });
        expect(await screen.findByText("판매 관리 권한이 없습니다.")).toBeVisible();
        view.unmount();
      }
    }
  });

  it("loads the second page without discarding the active inquiry", async () => {
    const pageTwo = { ...inquiry, id: "44444444-4444-4444-4444-444444444444", name: "박현우" };
    const client = api();
    vi.mocked(client.GET).mockImplementation((path: string, init: { params?: { query?: { offset?: number } } }) => {
      const offset = init.params?.query?.offset ?? 0;
      const data = path === "/api/v1/sales/listings"
        ? { items: offset === 0 ? [listing] : [], limit: 50, offset, total: 1 }
        : { items: offset === 0 ? [inquiry] : [pageTwo], limit: 50, offset, total: 51 };
      return Promise.resolve({ response: new Response(), data } as never);
    });
    render(<SalesCrmScreen api={client} />);
    await screen.findByRole("option", { name: /김민수/ });
    fireEvent.click(screen.getByRole("button", { name: "더 불러오기" }));
    expect(await screen.findByRole("option", { name: /박현우/ })).toBeVisible();
    expect(screen.getByRole("option", { name: /김민수/ })).toHaveAttribute("aria-selected", "true");
    expect(client.GET).toHaveBeenLastCalledWith("/api/v1/sales/inquiries", expect.objectContaining({ params: { query: expect.objectContaining({ offset: 1 }) } }));
  });

  it("supersedes an earlier refresh response and rejection with the later refresh", async () => {
    const staleListings = deferred<unknown>();
    const staleInquiries = deferred<unknown>();
    const freshListing = { ...listing, model_name: "E35 최신 전동 지게차" };
    const freshInquiry = { ...inquiry, name: "신규 문의 담당자" };
    let listingCalls = 0;
    let inquiryCalls = 0;
    const client = api();
    vi.mocked(client.GET).mockImplementation((path: string) => {
      if (path === "/api/v1/sales/listings") {
        listingCalls += 1;
        if (listingCalls === 2) return staleListings.promise;
        return Promise.resolve({ response: new Response(), data: { items: [listingCalls === 3 ? freshListing : listing], limit: 50, offset: 0, total: 1 } } as never);
      }
      inquiryCalls += 1;
      if (inquiryCalls === 2) return staleInquiries.promise;
      return Promise.resolve({ response: new Response(), data: { items: [inquiryCalls === 3 ? freshInquiry : inquiry], limit: 50, offset: 0, total: 1 } } as never);
    });
    render(<SalesCrmScreen api={client} />);
    await screen.findByRole("option", { name: /김민수/ });
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    expect(await screen.findByText("E35 최신 전동 지게차")).toBeVisible();
    expect(screen.getByRole("option", { name: /신규 문의 담당자/ })).toBeVisible();
    await act(async () => {
      staleListings.resolve({ response: new Response(), data: { items: [listing], limit: 50, offset: 0, total: 1 } });
      staleInquiries.reject(new Error("stale network failure"));
      await Promise.resolve();
    });
    expect(screen.getByText("E35 최신 전동 지게차")).toBeVisible();
    expect(screen.getByRole("option", { name: /신규 문의 담당자/ })).toBeVisible();
    const refreshCalls = vi.mocked(client.GET).mock.calls.slice(-4);
    expect(refreshCalls).toHaveLength(4);
    expect(refreshCalls.every(([, init]) => (init as { headers?: { "Cache-Control"?: string } }).headers?.["Cache-Control"] === "no-cache")).toBe(true);
  });

  it("does not start duplicate inquiry pagination while its own page is pending", async () => {
    const nextPage = { ...inquiry, id: "66666666-6666-6666-6666-666666666666", name: "추가 문의" };
    const inquiryMore = deferred<unknown>();
    const client = api();
    vi.mocked(client.GET).mockImplementation((path: string, init: { params?: { query?: { offset?: number } } }) => {
      const offset = init.params?.query?.offset ?? 0;
      if (path === "/api/v1/sales/listings") return Promise.resolve({ response: new Response(), data: { items: [listing], limit: 50, offset, total: 1 } } as never);
      if (offset === 1) return inquiryMore.promise;
      return Promise.resolve({ response: new Response(), data: { items: [inquiry], limit: 50, offset, total: 51 } } as never);
    });
    render(<SalesCrmScreen api={client} />);
    await screen.findByRole("option", { name: /김민수/ });
    const more = screen.getByRole("button", { name: "더 불러오기" });
    fireEvent.click(more);
    expect(more).toBeDisabled();
    fireEvent.click(more);
    expect(vi.mocked(client.GET).mock.calls.filter(([path, init]) => path === "/api/v1/sales/inquiries" && (init as { params: { query: { offset: number } } }).params.query.offset === 1)).toHaveLength(1);
    await act(async () => {
      inquiryMore.resolve({ response: new Response(), data: { items: [nextPage], limit: 50, offset: 1, total: 51 } });
      await Promise.resolve();
    });
    expect(await screen.findByRole("option", { name: /추가 문의/ })).toBeVisible();
  });

  it("disables all status transition controls with an accessible pending reason", async () => {
    const update = deferred<unknown>();
    const client = api();
    vi.mocked(client.PATCH).mockImplementation(() => update.promise);
    render(<SalesCrmScreen api={client} />);
    const advance = await screen.findByRole("button", { name: "연락 완료로 변경" });
    fireEvent.click(advance);
    expect(await screen.findByRole("status")).toHaveTextContent("상태 변경 중…");
    expect(screen.getByRole("button", { name: "상태 변경 중…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "상태 변경 중…" })).toHaveAttribute("aria-describedby", "sales-transition-pending");
    await act(async () => {
      update.resolve({ response: new Response(null, { status: 204 }) });
      await Promise.resolve();
    });
  });

  it("retains the selected detail and offers action-local recovery when a mutation rejects", async () => {
    const client = api();
    vi.mocked(client.PATCH).mockImplementation(() => Promise.reject(new Error("offline")));
    render(<SalesCrmScreen api={client} />);
    await screen.findByRole("button", { name: "연락 완료로 변경" });
    fireEvent.click(screen.getByRole("button", { name: "연락 완료로 변경" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("문의 상태를 변경하지 못했습니다.");
    expect(screen.getByText("현장 투입 가능 일정을 확인하고 싶습니다.")).toBeVisible();
    expect(screen.getByRole("button", { name: "다시 변경" })).toBeVisible();
  });
});
