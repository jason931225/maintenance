import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { laborCostStrings } from "../../laborcost";
import { LaborCostBody } from "./LaborCostBody";

const S = laborCostStrings();

const navigateSpy = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateSpy,
}));

const mockUseAuth = vi.fn();
vi.mock("../../../context/auth", () => ({
  useAuth: () => mockUseAuth() as unknown,
}));

const runs = [
  { id: "r3", period_start: "2026-06-01", period_end: "2026-06-30", status: "APPROVED" },
  { id: "r2", period_start: "2026-05-01", period_end: "2026-05-31", status: "ISSUED" },
  { id: "r1", period_start: "2026-04-01", period_end: "2026-04-30", status: "STAGED" },
];

// runId → summed line hours (regular, overtime, night, holiday).
const runHours: Record<string, [number, number, number, number]> = {
  r1: [100, 10, 5, 0], // Apr total 115
  r2: [120, 20, 10, 5], // May total 155
  r3: [140, 15, 8, 2], // Jun total 165
};

function line(id: string, [regular, overtime, night, holiday]: [number, number, number, number]) {
  return {
    id,
    employee_display_name: id,
    employee_company: "co",
    regular_hours: regular,
    overtime_hours: overtime,
    night_hours: night,
    holiday_hours: holiday,
    gross_pay_source_present: true,
    net_pay_source_present: true,
    nts_tax_row_status: "VERIFIED_SOURCE_ROW",
    calculation_status: "APPROVED",
    blockers: [],
  };
}

const projection = {
  point_estimate: 170,
  ci95_low: 130,
  ci95_high: 210,
  cvar95: 110,
  assumptions: {
    ewma_volatility: 20,
    student_t_nu: 4,
    drift: 5,
    simulations: 20_000,
    seed: 7,
  },
};

function setupAuth() {
  const GET = vi.fn(async (path: string, opts?: { params?: { path?: { id?: string } } }) => {
    await Promise.resolve();
    if (path === "/api/v1/payroll/runs") {
      return { data: { items: runs, total: runs.length, limit: 12, offset: 0 } };
    }
    if (path === "/api/v1/payroll/runs/{id}") {
      const id = opts?.params?.path?.id ?? "";
      return {
        data: {
          run: runs.find((r) => r.id === id),
          legal_basis: {},
          source_summary: {},
          lines: [line(`${id}-a`, runHours[id])],
          lines_total: 1,
          lines_limit: 500,
          lines_offset: 0,
        },
      };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  const POST = vi.fn(async (path: string) => {
    await Promise.resolve();
    if (path === "/api/v1/analytics/projection") return { data: projection };
    throw new Error(`unexpected POST ${path}`);
  });
  mockUseAuth.mockReturnValue({ api: { GET, POST }, session: { roles: ["ADMIN"] } });
  return { GET, POST };
}

afterEach(() => {
  mockUseAuth.mockReset();
  navigateSpy.mockReset();
});

describe("LaborCostBody", () => {
  it("aggregates real payroll hours per period and projects the trend via the backend", async () => {
    const { POST } = setupAuth();
    render(<LaborCostBody />);

    // Period strip renders every payroll run, newest first.
    expect(await screen.findByText("2026-06-01")).toBeVisible();
    expect(screen.getByText("2026-04-01")).toBeVisible();

    // Aggregate labor-hours composition (regular = 100+120+140 = 360h).
    expect(await screen.findByText(`360${(await import("../../../i18n/ko")).ko.common.hourUnit}`)).toBeVisible();

    // Backend projection fired over the real per-period totals, oldest first.
    await waitFor(() => {
      expect(POST).toHaveBeenCalledWith("/api/v1/analytics/projection", {
        body: { series: [115, 155, 165], horizon: 3, kind: "percent" },
      });
    });
    // Panel shows the backend point estimate (170h), not the client fallback.
    expect(await screen.findByText("170시간")).toBeVisible();
  });

  it("honestly names ₩ labor cost as pending (no fabricated amount)", async () => {
    setupAuth();
    render(<LaborCostBody />);
    expect(await screen.findByText(S.costPendingReason)).toBeVisible();
  });

  it("drills a payroll period to the payroll source screen", async () => {
    setupAuth();
    const user = userEvent.setup();
    render(<LaborCostBody />);

    const period = await screen.findByRole("button", {
      name: S.periodDrill("2026-06-01", S.status.APPROVED),
    });
    await user.click(period);
    expect(navigateSpy).toHaveBeenCalledWith("/payroll");
  });
});
