import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpsSummary } from "../../../api/types";
import { kpiReport } from "../../../test/fixtures";
import { dashboardStrings } from "../../dashboard/strings";
import { DashboardBody } from "./DashboardBody";

const S = dashboardStrings();
// error/retry copy now comes from the wired ko.console.dashboard.errorReason/retry.
const ERROR_REASON = S.errorReason ?? "Could not load metrics";
const RETRY = S.retry ?? "Retry";

const opsSummary: OpsSummary = {
  funnel: { received: 2, assigned: 1, in_progress: 3, completed: 5 },
  aging_hours: 24,
  aging_work_orders: 1,
  sla_breached: 1,
  sla_at_risk: 2,
  mechanic_load: [],
  equipment_status: { rented: 10, spare: 4, scrapped: 1, replacement: 2, sold: 0 },
  active_substitutions: 1,
  pending_approvals: 2,
  open_support_tickets: 4,
};

// useAuth is mocked so the body's self-fetch runs against a spied api client.
const mockUseAuth = vi.fn();
vi.mock("../../../context/auth", () => ({
  useAuth: () => mockUseAuth() as unknown,
}));

interface AuthOverrides {
  roles?: string[];
  kpi?: unknown;
  kpiReject?: boolean;
  opsPending?: boolean;
}

function setupAuth(overrides: AuthOverrides = {}) {
  const { roles = ["ADMIN"], kpi = kpiReport, kpiReject = false } = overrides;
  const GET = vi.fn(async (path: string) => {
    await Promise.resolve();
    if (path === "/api/v1/kpi") {
      if (kpiReject) throw new Error("boom");
      return { data: kpi };
    }
    if (path === "/api/v1/ops/summary") {
      if (overrides.opsPending) return new Promise(() => {}) as never;
      return { data: opsSummary };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  mockUseAuth.mockReturnValue({ api: { GET }, session: { roles } });
  return { GET };
}

function renderBody() {
  render(
    <MemoryRouter>
      <DashboardBody />
    </MemoryRouter>,
  );
}

afterEach(() => {
  mockUseAuth.mockReset();
});

describe("DashboardBody", () => {
  it("shows the loading state before the KPI report resolves", () => {
    setupAuth({ opsPending: true });
    renderBody();
    // Initial read state is loading; the DashboardScreen surfaces it as a chip.
    expect(screen.getByText("불러오는 중")).toBeVisible();
  });

  it("wires real KPI + ops data and every stat drills to its source screen", async () => {
    setupAuth();
    renderBody();

    // KPI stat drills into the dispatch object-set that sources it.
    const completed = await screen.findByRole("link", {
      name: "완료 건수 18건 상세 열기",
    });
    expect(completed).toHaveAttribute("href", "/dispatch?status=COMPLETED");
    // Ops stat drills to approvals (ops fetch fired for the ADMIN caller).
    expect(
      screen.getByRole("link", { name: "승인 대기 2건 상세 열기" }),
    ).toHaveAttribute("href", "/approvals");
  });

  it("omits the ops fetch (and ops stats) for a KPI-only non-ops role", async () => {
    const { GET } = setupAuth({ roles: ["EXECUTIVE"] });
    renderBody();

    await screen.findByRole("link", { name: "완료 건수 18건 상세 열기" });
    expect(GET).not.toHaveBeenCalledWith("/api/v1/ops/summary", expect.anything());
    expect(
      screen.queryByRole("link", { name: "승인 대기 2건 상세 열기" }),
    ).not.toBeInTheDocument();
  });

  it("renders the empty state when the report has no authorized rollups", async () => {
    setupAuth({ kpi: { ...kpiReport, rollups: [], unavailable_metrics: [] } });
    renderBody();

    expect(await screen.findByText(S.emptyReason)).toBeVisible();
    expect(screen.getByRole("link", { name: S.emptyAction })).toHaveAttribute(
      "href",
      "/dispatch",
    );
  });

  it("renders an error state with retry when the KPI fetch fails", async () => {
    const { GET } = setupAuth({ kpiReject: true });
    renderBody();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(ERROR_REASON);

    // Retry re-fires the fetch; recover with a good response.
    GET.mockImplementation(async (path: string) => {
      await Promise.resolve();
      if (path === "/api/v1/kpi") return { data: kpiReport };
      if (path === "/api/v1/ops/summary") return { data: opsSummary };
      throw new Error(`unexpected GET ${path}`);
    });
    await userEvent.click(screen.getByRole("button", { name: RETRY }));
    await waitFor(() => {
      expect(
        screen.getByRole("link", { name: "완료 건수 18건 상세 열기" }),
      ).toBeVisible();
    });
  });
});
