import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse, ws } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AppRouter } from "./AppRouter";
import { AuthContext } from "./context/auth";
import type { AuthContextValue, AuthSession } from "./context/auth";
import { createConsoleApiClient } from "./api/client";
import type { AbsenceExitDashboardResponse } from "./api/types";
import { ROUTE_LOAD_OPTIONS, waitForRouteReady } from "./test/routeReady";

vi.mock("./features/dispatch/leafletIcon", () => ({
  ensureLeafletIcon: vi.fn(),
}));

vi.mock("react-leaflet", () => ({
  MapContainer: ({ children }: { children: ReactNode }) => (
    <div data-testid="leaflet-map">{children}</div>
  ),
  Marker: ({ children }: { children?: ReactNode }) => (
    <div data-testid="leaflet-marker">{children}</div>
  ),
  Popup: ({ children }: { children?: ReactNode }) => (
    <div data-testid="leaflet-popup">{children}</div>
  ),
  TileLayer: () => <div data-testid="tile-layer" />,
}));

// ── Empty backend ───────────────────────────────────────────────────────────
// The production database is empty (0 work orders, 0 equipment, 0 branches).
// Every authenticated page must render cleanly against that — no throw, and a
// clear empty/loading state — so the per-route error boundary is never hit.

const BRANCH_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";

const messengerWs = ws.link("ws://localhost/api/v1/ws*");
const devMessengerWs = ws.link("ws://localhost:3000/api/v1/ws*");

// An otherwise-valid KPI report with no rollups and no data — the cold-start
// shape the aggregation endpoint returns before any work orders exist.
const emptyKpiReport = {
  period: { start: "2026-06-01T00:00:00Z", end: "2026-07-01T00:00:00Z" },
  requested_scope: { kind: "company" },
  rollups: [],
  unavailable_metrics: [],
};

const emptyConsentStatus = {
  consent_id: "00000000-0000-4000-8000-000000000011",
  user_id: USER_ID,
  branch_id: BRANCH_ID,
  state: "NO_RECORD",
  may_collect: false,
  granted_at: null,
  suspended_at: null,
  resumed_at: null,
  withdrawn_at: null,
  updated_at: "2026-06-12T00:00:00Z",
};

const emptyHrReadinessSummary = {
  imports: {
    runs: 0,
    applied_runs: 0,
    input_rows: 0,
    candidate_rows: 0,
    preserved_rows: 0,
    ledger_rows: 0,
    latest_import_at: null,
  },
  payroll: {
    draft_runs: 0,
    blocked_runs: 0,
    calculation_enabled_runs: 0,
    draft_lines: 0,
    payroll_source_rows: 0,
    attendance_source_rows: 0,
    attendance_event_links: 0,
    gross_pay_source_lines: 0,
    net_pay_source_lines: 0,
    latest_status: null,
    latest_source_label: null,
    latest_period_start: null,
    latest_period_end: null,
    latest_updated_at: null,
  },
  annual_leave: {
    obligations: 0,
    usage_promotion_required: 0,
    payout_review_required: 0,
    needs_review: 0,
    remaining_days: "0",
  },
  attendance: {
    durable_events: 0,
  },
};

const emptyAbsenceExitDashboard: AbsenceExitDashboardResponse = {
  summary: {
    open_absence_alerts: 0,
    exit_cases_pending_hr: 0,
    settlement_needs_source: 0,
    settlement_ready: 0,
    approval_drafts: 0,
    submitted: 0,
  },
  alerts: [],
  exit_cases: [],
};

const me = {
  id: USER_ID,
  display_name: "Cold Start Admin",
  phone: null,
  team: "MANAGEMENT",
  roles: ["SUPER_ADMIN"],
  branch_ids: [],
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
};

const server = setupServer(
  messengerWs.addEventListener("connection", () => {}),
  devMessengerWs.addEventListener("connection", () => {}),
  // Paginated list endpoints → empty page envelope.
  http.get("*/api/approval-items", () =>
    HttpResponse.json({
      items: [],
      sources: [
        { key: "workOrders", label: "작업 보고", status: "ok", count: 0 },
        { key: "dailyPlans", label: "계획업무", status: "ok", count: 0 },
        { key: "targetChanges", label: "일정 변경", status: "ok", count: 0 },
      ],
      limit: 100,
      offset: 0,
      total: 0,
    }),
  ),
  http.get("*/api/v1/work-orders", () =>
    HttpResponse.json({ items: [], limit: 100, offset: 0, total: 0 }),
  ),
  http.get("*/api/v1/equipment", () =>
    HttpResponse.json({ items: [], limit: 5 }),
  ),
  http.get("*/api/v1/equipment/list", () =>
    HttpResponse.json({ items: [], total: 0, limit: 50, offset: 0 }),
  ),
  http.get("*/api/v1/equipment/lookup", () =>
    HttpResponse.json({ message: "not found" }, { status: 404 }),
  ),
  // Dispatch-map aggregation: no sites in a cold-start tenant → empty page.
  http.get("*/api/v1/equipment-by-location", () =>
    HttpResponse.json({ items: [], total: 0 }),
  ),
  http.get("*/api/v1/kpi", () => HttpResponse.json(emptyKpiReport)),
  // Console workspace layout (UI-M1b): ConsoleShell loads it on mount for
  // /overview and /attendance. Empty backend => empty layout object.
  http.get("*/api/v1/me/workspace", () => HttpResponse.json({ layout: {} })),
  http.put("*/api/v1/me/workspace", () => HttpResponse.json({ layout: {} })),
  http.get("*/api/messenger/threads", () =>
    HttpResponse.json({ items: [] }),
  ),
  // UI-M3 Overview sources: engine approval inbox, my dispatch offers, todos.
  http.get("*/api/v1/workflow-tasks", () => HttpResponse.json({ items: [] })),
  http.get("*/api/v1/me/dispatch-offers", () =>
    HttpResponse.json({ items: [] }),
  ),
  http.get("*/api/v1/me/todos", () => HttpResponse.json({ items: [] })),
  http.get("*/api/v1/mail/folders", () => HttpResponse.json([])),
  http.get("*/api/v1/me/notifications", () =>
    HttpResponse.json({ items: [], next_cursor: null }),
  ),
  http.get("*/api/v1/me/notifications/unread-count", () =>
    HttpResponse.json({ unread: 0 }),
  ),
  http.get("*/api/daily-work-plans", () =>
    HttpResponse.json({ items: [] }),
  ),
  // Paginated list endpoints → empty page envelopes.
  http.get("*/api/v1/support/tickets", () =>
    HttpResponse.json({ items: [], next_cursor: null, total: 0 }),
  ),
  http.get("*/api/v1/users", () =>
    HttpResponse.json({ items: [], limit: 200, offset: 0, total: 0 }),
  ),
  http.get("*/api/v1/employees", () =>
    HttpResponse.json({ items: [], limit: 1000, offset: 0, total: 0 }),
  ),
  http.get("*/api/v1/hr/attendance-summary", () =>
    HttpResponse.json({ items: [], limit: 1000, offset: 0, total: 0 }),
  ),
  // AttendancePage is mounted by ConsoleShell for persistence, but inactive
  // screens must not fetch. The counter below locks the /overview no-hidden-fetch
  // regression (its Today panel makes exactly ONE punch-status read) while
  // still serving /attendance when it becomes active.
  http.get("*/api/v1/hr/attendance-records/me", () => {
    attendanceRecordReads += 1;
    return HttpResponse.json({ items: [] });
  }),
  http.get("*/api/v1/hr/readiness-summary", () =>
    HttpResponse.json(emptyHrReadinessSummary),
  ),
  http.get("*/api/v1/hr/absence-exit-dashboard", () =>
    HttpResponse.json(emptyAbsenceExitDashboard),
  ),
  http.get("*/api/v1/hr/leave-balances", () =>
    HttpResponse.json({
      items: [],
      total: 0,
      limit: 1000,
      offset: 0,
      summary: { accrued: "0", used: "0", remaining: "0" },
    }),
  ),
  http.get("*/api/v1/inspections/schedules", () =>
    HttpResponse.json({ items: [], limit: 200, offset: 0, total: 0 }),
  ),
  // Bare-array list endpoints → empty array.
  http.get("*/api/v1/users/me", () => HttpResponse.json(me)),
  http.get("*/api/v1/branches", () => HttpResponse.json([])),
  http.get("*/api/v1/regions", () => HttpResponse.json([])),
  // Location consent (cold start: no record yet).
  http.get("*/api/v1/location-consent/status", () =>
    HttpResponse.json(emptyConsentStatus),
  ),
  http.get("*/api/v1/location-consents/ledger", () =>
    HttpResponse.json({ items: [], limit: 10, offset: 0, total: 0 }),
  ),
  http.get("*/api/v1/location/arrival-events", () =>
    HttpResponse.json({ items: [], limit: 50, offset: 0, total: 0 }),
  ),
);

let attendanceRecordReads = 0;

// Track in-flight HTTP requests so a test can wait for late on-mount fetches
// (e.g. the dispatch-map aggregation the equipment screen issues) to fully
// resolve before it ends. WebSocket connections intentionally remain open and
// should not hold HTTP idle checks hostage.
const inFlightHttpRequests = new Map<string, string>();
server.events.on("request:start", ({ request, requestId }) => {
  if (request.url.startsWith("http://") || request.url.startsWith("https://")) {
    inFlightHttpRequests.set(requestId, request.url);
  }
});
server.events.on("request:end", ({ requestId }) => {
  inFlightHttpRequests.delete(requestId);
});

async function waitForNetworkIdle() {
  await waitFor(() => {
    expect(Array.from(inFlightHttpRequests.values())).toEqual([]);
  });
}

async function waitForLateMountEffects() {
  await new Promise((resolve) => {
    setTimeout(resolve, 25);
  });
  await waitForNetworkIdle();
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  attendanceRecordReads = 0;
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

// A super-admin session so admin-gated pages (users / org / security) render.
const session: AuthSession = {
  access_token: "a",
  user_id: USER_ID,
  roles: ["SUPER_ADMIN"],
  branches: [BRANCH_ID],
};

function makeAuthContext(s: AuthSession): AuthContextValue {
  return {
    session: s,
    restoring: false,
    login: async () => {},
    logout: async () => {},
    refresh: async () => {},
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    viewAs: undefined,
    enterViewAs: () => {},
    exitViewAs: () => undefined,
    api: createConsoleApiClient(s.access_token),
  };
}

function renderAt(path: string) {
  return render(
    <AuthContext.Provider value={makeAuthContext(session)}>
      <MemoryRouter initialEntries={[path]}>
        <AppRouter />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

// Each entry: route, the page's heading (proves it mounted, shell intact), and
// the empty-state copy that must appear with an empty backend.
const pages: { path: string; heading: string; empty: string }[] = [
  { path: "/overview", heading: "통합 개요", empty: "현재 처리할 항목이 없습니다." },
  { path: "/dispatch", heading: "배차 보드", empty: "표시할 접수건이 없습니다." },
  { path: "/approvals", heading: "전자결제 대기", empty: "승인 대기 건이 없습니다." },
  { path: "/kpi", heading: "임원 KPI 대시보드", empty: "KPI 데이터를 불러오면 표시됩니다." },
  { path: "/messenger", heading: "메신저", empty: "표시할 대화방이 없습니다." },
  { path: "/support", heading: "고객지원 티켓", empty: "표시할 티켓이 없습니다." },
  { path: "/settings/users", heading: "사용자 관리", empty: "등록된 사용자가 없습니다." },
  { path: "/settings/org", heading: "지역·지점 관리", empty: "등록된 지역이 없습니다." },
];

describe("every page renders cleanly against an empty backend", () => {
  // A render-time throw escaping a page would be logged by the route error
  // boundary's componentDidCatch; assert it never fires.
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  afterEach(() => {
    consoleError.mockClear();
  });

  for (const page of pages) {
    it(`renders ${page.path} with its empty state and no crash`, async () => {
      renderAt(page.path);

      // PageHeader owns the page's single <h1>; the sidebar nav and feature
      // panels reuse the same label as a link / <h2>, so pin level: 1.
      expect(await waitForRouteReady(page.heading)).toBeVisible();
      // Empty copy can surface in more than one sub-panel (e.g. the dispatch
      // board and the work-order list) — assert at least one is shown.
      expect(
        (await screen.findAllByText(page.empty, undefined, ROUTE_LOAD_OPTIONS))[0],
      ).toBeVisible();

      // The per-route error boundary fallback must never appear.
      expect(
        screen.queryByText("이 화면을 표시하지 못했습니다."),
      ).not.toBeInTheDocument();
      // No render error was caught/logged.
      expect(consoleError).not.toHaveBeenCalledWith(
        "Page render error:",
        expect.anything(),
        expect.anything(),
      );
    });
  }

  it("reads punch status exactly once while Overview is active (no hidden attendance-screen fetch)", async () => {
    renderAt("/overview");
    expect(await waitForRouteReady("통합 개요")).toBeVisible();
    await waitForNetworkIdle();
    // The Today panel's punch-status chip issues ONE read; the mounted-but-
    // inactive attendance screen must not add its own.
    expect(attendanceRecordReads).toBe(1);
    await waitForLateMountEffects();
    expect(attendanceRecordReads).toBe(1);
  });

  it("fetches attendance records once the attendance screen is active", async () => {
    renderAt("/attendance");
    expect(await waitForRouteReady("내 근태 기록")).toBeVisible();
    await waitFor(() => {
      expect(attendanceRecordReads).toBe(1);
    });
  });

  it("renders /payroll with zero readiness counts and no crash", async () => {
    renderAt("/payroll");
    expect(await waitForRouteReady("급여 준비")).toBeVisible();
    expect(await screen.findByText("급여 산출 준비도")).toBeVisible();
    expect(await screen.findByText("법적 검토 게이트 차단")).toBeVisible();
    await waitForNetworkIdle();
  });

  it("renders /equipment (no data assumed) without crashing", async () => {
    renderAt("/equipment");
    expect(await waitForRouteReady("장비 조회")).toBeVisible();
    // Empty response → empty-state message rendered.
    expect(
      await screen.findByText(
        "조건에 맞는 장비가 없습니다.",
        undefined,
        ROUTE_LOAD_OPTIONS,
      ),
    ).toBeVisible();
    await waitForNetworkIdle();
  });

  it("renders /intake against an empty backend", async () => {
    renderAt("/intake");
    expect(await waitForRouteReady("접수 입력")).toBeVisible();
  });

  it("renders /dispatch-map empty-state (no geocoded sites) without a blank map", async () => {
    renderAt("/dispatch-map");
    expect(await waitForRouteReady("배차 지도")).toBeVisible();
    // Zero geocoded sites must surface the empty-state message + a link to site
    // management, never a blank map or a fabricated pin.
    expect(
      await screen.findByText(/좌표가 입력된 사업장이 없습니다/),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "사업장 관리로 이동" }),
    ).toBeVisible();
    await waitForNetworkIdle();
  });

  it("renders /settings/location against an empty backend", async () => {
    renderAt("/settings/location");
    expect(await waitForRouteReady("GPS 위치 동의")).toBeVisible();
  });

  it("renders /settings/profile against an empty backend", async () => {
    renderAt("/settings/profile");
    expect(await waitForRouteReady("내 프로필")).toBeVisible();
  });

  it("renders /wallboard (kiosk) against an empty backend", async () => {
    renderAt("/wallboard");
    expect(
      await screen.findByRole("heading", { name: "일일현황 월보드" }),
    ).toBeVisible();
  });
});
