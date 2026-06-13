import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { App } from "./App";
import { getDefaultKpiPeriod } from "./features/kpi/kpi-format";
import {
  equipmentLookup,
  kpiReport,
  tokenPair,
  workOrderListItems,
  workOrders,
} from "./test/fixtures";

const listRequests: URL[] = [];
const kpiRequests: URL[] = [];
const autocompleteRequests: URL[] = [];
const lookupRequests: URL[] = [];
let rejectRequest:
  | {
      url: URL;
      body: unknown;
    }
  | undefined;

const server = setupServer(
  http.get("*/api/v1/work-orders", ({ request }) => {
    const url = new URL(request.url);
    listRequests.push(url);
    const statusFilter = url.searchParams.getAll("status").flatMap((value) =>
      value.split(","),
    );
    const items =
      statusFilter.length > 0
        ? workOrderListItems.filter((workOrder) =>
            statusFilter.includes(workOrder.status),
          )
        : workOrderListItems;

    return HttpResponse.json({
      items,
      limit: Number(url.searchParams.get("limit") ?? 100),
      offset: Number(url.searchParams.get("offset") ?? 0),
      total: items.length,
    });
  }),
  http.get("*/api/v1/kpi", ({ request }) => {
    const url = new URL(request.url);
    kpiRequests.push(url);
    return HttpResponse.json(kpiReport);
  }),
  http.get("*/api/v1/location-consent/status", () =>
    HttpResponse.json({
      consent_id: "00000000-0000-4000-8000-000000000011",
      user_id: "00000000-0000-4000-8000-000000000002",
      branch_id: "00000000-0000-4000-8000-000000000001",
      state: "GRANTED",
      may_collect: true,
      granted_at: "2026-06-12T00:00:00Z",
      suspended_at: null,
      resumed_at: null,
      withdrawn_at: null,
      updated_at: "2026-06-12T00:00:00Z",
    }),
  ),
  http.get("*/api/v1/location-consents/ledger", () =>
    HttpResponse.json({
      items: [],
      limit: 10,
      offset: 0,
      total: 0,
    }),
  ),
  http.get("*/api/v1/equipment", ({ request }) => {
    const url = new URL(request.url);
    autocompleteRequests.push(url);
    return HttpResponse.json({
      items: [equipmentLookup],
      limit: Number(url.searchParams.get("limit") ?? 5),
    });
  }),
  http.get("*/api/v1/equipment/lookup", ({ request }) => {
    const url = new URL(request.url);
    lookupRequests.push(url);
    return HttpResponse.json(equipmentLookup);
  }),
  http.get("*/api/messenger/threads", () =>
    HttpResponse.json({
      items: [],
    }),
  ),
  http.post(
    "*/api/v1/work-orders/:workOrderId/reject",
    async ({ request }) => {
      rejectRequest = {
        url: new URL(request.url),
        body: await request.json(),
      };
      return HttpResponse.json({
        ...workOrders[1],
        status: "REJECTED",
      });
    },
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
  listRequests.length = 0;
  kpiRequests.length = 0;
  autocompleteRequests.length = 0;
  lookupRequests.length = 0;
  rejectRequest = undefined;
  window.history.pushState({}, "", "/");
});

afterAll(() => {
  server.close();
});

describe("App", () => {
  it("loads the board/list and approval queue from the read API with the required filters", async () => {
    render(<App initialSession={tokenPair} />);

    expect((await screen.findAllByText("20260612-001"))[0]).toBeVisible();
    expect(screen.getByRole("heading", { name: "작업지시 목록" })).toBeVisible();
    expect(screen.getAllByText(/한빛물류/)[0]).toBeVisible();

    await waitFor(() => {
      expect(
        listRequests.some(
          (url) =>
            url.pathname === "/api/v1/work-orders" &&
            !url.search.includes("status"),
        ),
      ).toBe(true);
      expect(
        listRequests.some(
          (url) =>
            url.pathname === "/api/v1/work-orders" &&
            url.search.includes("REPORT_SUBMITTED") &&
            url.search.includes("ADMIN_REVIEW"),
        ),
      ).toBe(true);
      expect(
        kpiRequests.some(
          (url) =>
            url.pathname === "/api/v1/kpi" &&
            url.searchParams.get("period") === getDefaultKpiPeriod(),
        ),
      ).toBe(true);
    });
  });

  it("renders the wallboard route without the console controls", async () => {
    window.history.pushState({}, "", "/wallboard");

    render(<App initialSession={tokenPair} />);

    expect(
      await screen.findByRole("heading", { name: "일일현황 월보드" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "패스키 로그인" }),
    ).not.toBeInTheDocument();
  });

  it("uses equipment autocomplete and lookup when the intake 호기 changes", async () => {
    const user = userEvent.setup();

    render(<App initialSession={tokenPair} />);

    await user.type(screen.getByLabelText("호기"), "#290");

    expect((await screen.findAllByText("GTS25DE"))[0]).toBeVisible();
    expect(screen.getByText("케이앤엘")).toBeVisible();

    await waitFor(() => {
      expect(
        autocompleteRequests.some(
          (url) =>
            url.pathname === "/api/v1/equipment" &&
            url.searchParams.get("q") === "#290",
        ),
      ).toBe(true);
      expect(
        lookupRequests.some(
          (url) =>
            url.pathname === "/api/v1/equipment/lookup" &&
            url.searchParams.get("management_no") === "#290",
        ),
      ).toBe(true);
    });
  });

  it("posts reject memo through the read-surface reject route", async () => {
    const user = userEvent.setup();

    render(<App initialSession={tokenPair} />);

    expect((await screen.findAllByText("20260612-002"))[0]).toBeVisible();
    await user.type(screen.getByLabelText("검토 메모"), "증빙 보완 필요");
    await user.click(
      screen.getByRole("button", { name: "20260612-002 반려" }),
    );

    await waitFor(() => {
      expect(rejectRequest?.url.pathname).toBe(
        `/api/v1/work-orders/${workOrderListItems[1].id}/reject`,
      );
      expect(rejectRequest?.body).toEqual({ memo: "증빙 보완 필요" });
    });
  });
});
