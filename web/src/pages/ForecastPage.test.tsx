import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AssetLifecycleCostSummary, EquipmentListItem } from "../api/types";
import { createConsoleApiClient } from "../api/client";
import { fcCode } from "../console/forecast";
import { ko } from "../i18n/ko";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { ForecastPage } from "./ForecastPage";

const equipment: EquipmentListItem = {
  equipment_id: "aaaa1111-bbbb-2222-cccc-333344445555",
  branch_id: "00000000-0000-4000-8000-000000000009",
  equipment_no: "FL-0042",
  status: "rented",
  specification: "3톤 지게차",
  ton_text: "3T",
  customer_name: "동해건설",
  site_name: "창원공장",
  updated_at: "2026-07-01T00:00:00Z",
};

const lifecycleCost: AssetLifecycleCostSummary = {
  equipment_id: equipment.equipment_id,
  equipment_no: equipment.equipment_no,
  status: "rented",
  acquisition_source: "EXPLICIT",
  maintenance_total_won: 400_000,
  manual_total_won: 400_000,
  purchase_total_won: 0,
  entry_count: 2,
  residual_value_won: 0,
  tco_won: 400_000,
  timeline: [
    {
      id: "1",
      branch_id: equipment.branch_id,
      equipment_id: equipment.equipment_id,
      work_order_id: null,
      purchase_request_id: null,
      source: "MANUAL_ADMIN",
      amount_won: 200_000,
      memo: "",
      residual_before_won: 0,
      residual_after_won: 0,
      entry_at: "2026-06-01T00:00:00Z",
    },
    {
      id: "2",
      branch_id: equipment.branch_id,
      equipment_id: equipment.equipment_id,
      work_order_id: null,
      purchase_request_id: null,
      source: "MANUAL_ADMIN",
      amount_won: 200_000,
      memo: "",
      residual_before_won: 0,
      residual_after_won: 0,
      entry_at: "2026-07-01T00:00:00Z",
    },
  ],
};

const NOW = new Date("2026-07-10T09:00:00Z");

let requestedEquipmentIds: string[] = [];

const server = setupServer(
  http.get("*/api/v1/equipment/list", ({ request }) => {
    const q = new URL(request.url).searchParams.get("q") ?? "";
    return HttpResponse.json({ items: q.length > 0 ? [equipment] : [], total: q.length > 0 ? 1 : 0 });
  }),
  http.get("*/api/v1/financial/equipment/:equipmentId/lifecycle-cost", ({ params }) => {
    requestedEquipmentIds.push(String(params.equipmentId));
    return HttpResponse.json(lifecycleCost);
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  requestedEquipmentIds = [];
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

function renderForecastPage() {
  const session: AuthSession = {
    access_token: "test-token",
    user_id: "00000000-0000-4000-8000-000000000002",
    display_name: "관리자A",
    roles: ["ADMIN"],
    branches: [],
  };
  const ctx: AuthContextValue = {
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
    api: createConsoleApiClient(session.access_token),
  };
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter>
        <ForecastPage />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("ForecastPage — real cost-ledger wiring", () => {
  it("searches real equipment, fetches its real cost ledger, and projects it", async () => {
    renderForecastPage();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });

    await user.type(screen.getByRole("searchbox"), "FL-0042");

    const result = await screen.findByRole("button", { name: /FL-0042/ });
    await user.click(result);

    await waitFor(() => {
      expect(requestedEquipmentIds).toEqual([equipment.equipment_id]);
    });

    // The real ledger (₩200,000 x2 within the default 6-mo horizon) renders
    // through console/charts ProjectionPanel — no fabricated numbers. Constant
    // sample -> zero variance -> point estimate is exactly ₩200,000.
    const T = ko.console.charts;
    expect(await screen.findByText(fcCode(equipment.equipment_id))).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: T.drill(T.projection.point, "₩200,000") }),
    ).toBeInTheDocument();
  });
});
