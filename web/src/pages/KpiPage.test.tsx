import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createConsoleApiClient } from "../api/client";
import { dashboardStrings } from "../console/dashboard/strings";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { kpiReport } from "../test/fixtures";
import { KpiPage } from "./KpiPage";

const S = dashboardStrings();

// Fixture period is 2026-06; the period segments derive from "now", so pin
// the clock to keep the ongoing/closed month labels deterministic.
const NOW = new Date("2026-07-10T09:00:00Z");

// Every /api/v1/kpi request's period param, in order — the refetch proof.
let requestedPeriods: string[] = [];

const server = setupServer(
  http.get("*/api/v1/kpi", ({ request }) => {
    requestedPeriods.push(new URL(request.url).searchParams.get("period") ?? "");
    return HttpResponse.json(kpiReport);
  }),
  // KpiPage tolerates a missing ops summary (honest omission).
  http.get("*/api/v1/ops/summary", () => new HttpResponse(null, { status: 403 })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  requestedPeriods = [];
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

function renderKpiPage() {
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
        <KpiPage />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("KpiPage period refetch", () => {
  it("refetches the KPI report when a typed month segment is chosen", async () => {
    renderKpiPage();

    // Initial load fetches the ongoing month derived from the pinned clock.
    const group = await screen.findByRole("group", { name: "기간" });
    await waitFor(() => {
      expect(requestedPeriods).toEqual(["2026-07-01..2026-08-01"]);
    });

    const user = userEvent.setup({
      advanceTimers: (ms) => vi.advanceTimersByTime(ms),
    });
    await user.click(
      within(group).getByRole("button", { name: S.periodClosed("6월") }),
    );

    // The segment click drives a real second fetch for the closed month.
    await waitFor(() => {
      expect(requestedPeriods).toEqual([
        "2026-07-01..2026-08-01",
        "2026-06-01..2026-07-01",
      ]);
    });
    expect(
      within(group).getByRole("button", { name: S.periodClosed("6월") }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});
