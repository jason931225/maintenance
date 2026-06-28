import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse, ws } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AppRouter } from "./AppRouter";
import { AuthContext } from "./context/auth";
import type { AuthContextValue, AuthSession } from "./context/auth";
import { createConsoleApiClient } from "./api/client";

// ── Empty backend ───────────────────────────────────────────────────────────
// The production database is empty (0 work orders, 0 equipment, 0 branches).
// Every authenticated page must render cleanly against that — no throw, and a
// clear empty/loading state — so the per-route error boundary is never hit.

const BRANCH_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";

const messengerWs = ws.link("ws://localhost:3000/api/v1/ws*");

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
  // Paginated list endpoints → empty page envelope.
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
  http.get("*/api/messenger/threads", () =>
    HttpResponse.json({ items: [] }),
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

// Track in-flight requests so a test can wait for late on-mount fetches (e.g.
// the dispatch-map aggregation the equipment screen issues) to fully resolve
// before it ends — otherwise the request would escape this file's MSW window
// and hit the real network during a later test file.
let inFlight = 0;
server.events.on("request:start", () => {
  inFlight += 1;
});
server.events.on("request:end", () => {
  inFlight -= 1;
});

async function waitForNetworkIdle() {
  await waitFor(() => {
    expect(inFlight).toBe(0);
  });
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
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
  { path: "/work-hub", heading: "업무 허브", empty: "현재 처리할 업무·승인·대화가 없습니다." },
  { path: "/dispatch", heading: "배차 보드", empty: "표시할 접수건이 없습니다." },
  { path: "/approvals", heading: "승인 대기", empty: "승인 대기 건이 없습니다." },
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
      expect(
        await screen.findByRole("heading", { name: page.heading, level: 1 }),
      ).toBeVisible();
      // Empty copy can surface in more than one sub-panel (e.g. the dispatch
      // board and the work-order list) — assert at least one is shown.
      expect((await screen.findAllByText(page.empty))[0]).toBeVisible();

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

  it("renders /equipment (no data assumed) without crashing", async () => {
    renderAt("/equipment");
    expect(
      await screen.findByRole("heading", { name: "장비 조회", level: 1 }),
    ).toBeVisible();
    // Empty response → empty-state message rendered.
    expect(
      await screen.findByText("조건에 맞는 장비가 없습니다."),
    ).toBeVisible();
    await waitForNetworkIdle();
  });

  it("renders /intake against an empty backend", async () => {
    renderAt("/intake");
    expect(
      await screen.findByRole("heading", { name: "접수 입력", level: 1 }),
    ).toBeVisible();
  });

  it("renders /dispatch-map empty-state (no geocoded sites) without a blank map", async () => {
    renderAt("/dispatch-map");
    expect(
      await screen.findByRole("heading", { name: "배차 지도", level: 1 }),
    ).toBeVisible();
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
    expect(
      await screen.findByRole("heading", { name: "GPS 위치 동의", level: 1 }),
    ).toBeVisible();
  });

  it("renders /settings/profile against an empty backend", async () => {
    renderAt("/settings/profile");
    expect(
      await screen.findByRole("heading", { name: "내 프로필", level: 1 }),
    ).toBeVisible();
  });

  it("renders /wallboard (kiosk) against an empty backend", async () => {
    renderAt("/wallboard");
    expect(
      await screen.findByRole("heading", { name: "일일현황 월보드" }),
    ).toBeVisible();
  });
});
