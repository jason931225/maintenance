import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../api/client";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { AuthContext } from "../context/auth";
import { DispatchMapPage } from "./DispatchMapPage";

vi.mock("../features/dispatch/leafletIcon", () => ({
  ensureLeafletIcon: vi.fn(),
}));

interface MockMarkerProps {
  children: ReactNode;
  position: [number, number];
  eventHandlers?: {
    click?: () => void;
  };
}

vi.mock("react-leaflet", () => ({
  MapContainer: ({ children }: { children: ReactNode }) => (
    <div data-testid="leaflet-map">{children}</div>
  ),
  TileLayer: () => <div data-testid="tile-layer" />,
  Marker: ({ children, position, eventHandlers }: MockMarkerProps) => (
    <div
      aria-label={`marker ${String(position[0])},${String(position[1])}`}
      data-lat={position[0]}
      data-lng={position[1]}
      data-testid="leaflet-marker"
      role="button"
      tabIndex={0}
      onClick={() => {
        eventHandlers?.click?.();
      }}
    >
      {children}
    </div>
  ),
  Popup: ({ children }: { children: ReactNode }) => (
    <div data-testid="leaflet-popup">{children}</div>
  ),
}));

const branchId = "00000000-0000-4000-8000-000000000001";
const siteId = "11111111-1111-4111-8111-111111111111";
const workOrderId = "22222222-2222-4222-8222-222222222222";

const site = {
  site_id: siteId,
  site_name: "코스 부산 물류센터",
  customer_id: "33333333-3333-4333-8333-333333333333",
  customer_name: "코스",
  branch_id: branchId,
  address: "부산광역시 강서구",
  postal_code: "46700",
  province: "부산",
  city: "강서구",
  latitude: 35.1796,
  longitude: 129.0756,
  geofence_radius_m: 300,
  contact_name: null,
  contact_phone: null,
  contact_email: null,
  equipment_count: 4,
  rented_count: 3,
  spare_count: 1,
  substitution_active_count: 0,
};

const ungeocodedSite = {
  ...site,
  site_id: "44444444-4444-4444-8444-444444444444",
  site_name: "좌표 미입력 사업장",
  latitude: null,
  longitude: null,
  equipment_count: 1,
  rented_count: 0,
  spare_count: 1,
};

const arrivalEvent = {
  id: "55555555-5555-4555-8555-555555555555",
  work_order_id: workOrderId,
  site_id: siteId,
  work_order_no: "20260612-001",
  site_name: site.site_name,
  customer_name: site.customer_name,
  mechanic_name: "김정비",
  latitude: site.latitude,
  longitude: site.longitude,
  kind: "ARRIVAL",
  occurred_at: "2026-06-12T00:00:00Z",
} as const;

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

function makeAuthContext(session: AuthSession): AuthContextValue {
  const api = createConsoleApiClient(session.access_token);
  return {
    session,
    restoring: false,
    login: async () => {},
    logout: async () => {},
    refresh: async () => {},
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    viewAs: undefined,
    enterViewAs: () => {},
    exitViewAs: () => undefined,
    api,
  };
}

function renderPage() {
  const session: AuthSession = {
    access_token: "token",
    user_id: "00000000-0000-4000-8000-000000000099",
    roles: ["ADMIN"],
    branches: [branchId],
  };

  return render(
    <AuthContext.Provider value={makeAuthContext(session)}>
      <MemoryRouter>
        <DispatchMapPage />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

function equipmentByLocationHandler(items = [site, ungeocodedSite]) {
  return http.get("*/api/v1/equipment-by-location", () =>
    HttpResponse.json({ items, total: items.length }),
  );
}

function arrivalEventsHandler(items = [arrivalEvent]) {
  return http.get("*/api/v1/location/arrival-events", () =>
    HttpResponse.json({ items, limit: 50, offset: 0, total: items.length }),
  );
}

describe("DispatchMapPage", () => {
  it("renders geocoded site pins, keeps ungeocoded sites in the side list, and opens the selected site panel", async () => {
    const user = userEvent.setup();
    server.use(equipmentByLocationHandler(), arrivalEventsHandler([]));

    renderPage();

    expect(await screen.findByTestId("leaflet-map")).toBeInTheDocument();
    expect(screen.getAllByText("좌표 미입력 사업장").length).toBeGreaterThan(0);

    await user.click(screen.getAllByTestId("leaflet-marker")[0]);

    await waitFor(() => {
      const panels = screen.getAllByText(site.site_name);
      expect(panels.length).toBeGreaterThan(1);
    });
    expect(screen.getByText("전체 장비")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("renders on-duty arrival and return markers with routing while keeping raw GPS out of the UI", async () => {
    server.use(
      equipmentByLocationHandler([site]),
      arrivalEventsHandler([
        arrivalEvent,
        {
          ...arrivalEvent,
          id: "66666666-6666-4666-8666-666666666666",
          kind: "DEPARTURE",
          occurred_at: "2026-06-12T01:00:00Z",
        },
      ]),
    );

    renderPage();

    expect(await screen.findByText("현장 도착·복귀")).toBeInTheDocument();
    expect(screen.getAllByText(/김정비/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("도착").length).toBeGreaterThan(0);
    expect(screen.getAllByText("복귀").length).toBeGreaterThan(0);
    expect(
      screen.getByText(/원시 GPS는 표시하지 않습니다/),
    ).toBeInTheDocument();

    const routeLinks = screen.getAllByRole("link", { name: "길찾기" });
    expect(routeLinks[0]).toHaveAttribute(
      "href",
      expect.stringContaining("google.com/maps/dir"),
    );
    expect(routeLinks[0]).toHaveAttribute(
      "href",
      expect.stringContaining("destination=35.1796%2C129.0756"),
    );

    const markerCoordinates = screen
      .getAllByTestId("leaflet-marker")
      .map(
        (marker) =>
          `${marker.dataset.lat ?? ""},${marker.dataset.lng ?? ""}`,
      );
    expect(markerCoordinates).toContain("35.1796,129.0756");
  });

  it("does not draw arrival markers for events that do not have admin-entered site coordinates", async () => {
    server.use(
      equipmentByLocationHandler([site]),
      arrivalEventsHandler([
        {
          ...arrivalEvent,
          latitude: null,
          longitude: null,
        },
      ]),
    );

    renderPage();

    expect(await screen.findByText("현장 도착·복귀")).toBeInTheDocument();
    expect(
      screen.getByText(/좌표가 입력된 사업장이 없어 지도에 표시할 수 없습니다/),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("leaflet-marker")).toHaveLength(1);
  });

  it("keeps unmapped arrival facts visible while routing only mapped records", async () => {
    server.use(
      equipmentByLocationHandler([site]),
      arrivalEventsHandler([
        arrivalEvent,
        {
          ...arrivalEvent,
          id: "77777777-7777-4777-8777-777777777777",
          site_name: "좌표 없는 현장",
          latitude: null,
          longitude: null,
        },
      ]),
    );

    renderPage();

    expect(await screen.findByText("현장 도착·복귀")).toBeInTheDocument();
    expect(screen.getByText("좌표 없는 현장")).toBeInTheDocument();
    expect(
      screen.getByText(/좌표가 입력된 사업장이 없어 지도에 표시할 수 없습니다/),
    ).toBeInTheDocument();
    // One mapped event exposes route links in both its map popup and list row;
    // the unmapped event contributes no route link and no marker.
    expect(screen.getAllByRole("link", { name: "길찾기" })).toHaveLength(2);
    expect(screen.getAllByTestId("leaflet-marker")).toHaveLength(2);
  });

  it("keeps the map usable when arrival events are outside the operator's branch or permission scope", async () => {
    server.use(
      equipmentByLocationHandler([site]),
      http.get("*/api/v1/location/arrival-events", () =>
        HttpResponse.json(
          { error: { message: "branch_id required" } },
          { status: 422 },
        ),
      ),
    );

    renderPage();

    expect(await screen.findByTestId("leaflet-map")).toBeInTheDocument();
    expect(screen.getAllByText(site.site_name).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/현재 권한 또는 지점 범위에서 도착·복귀 기록을 표시할 수 없습니다/),
    ).toBeInTheDocument();
  });

  it("surfaces transport-level arrival feed failures without blocking the map", async () => {
    server.use(
      equipmentByLocationHandler([site]),
      http.get("*/api/v1/location/arrival-events", () => HttpResponse.error()),
    );

    renderPage();

    expect(await screen.findByTestId("leaflet-map")).toBeInTheDocument();
    expect(screen.getAllByText(site.site_name).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/도착·복귀 기록을 불러오지 못했습니다/),
    ).toBeInTheDocument();
  });
});
