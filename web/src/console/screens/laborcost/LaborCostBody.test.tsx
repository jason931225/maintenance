import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { laborCostStrings } from "../../laborcost";
import { ko } from "../../../i18n/ko";
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

type GetOptions = {
  params?: {
    path?: { id?: string };
    query?: { limit?: number; offset?: number };
  };
};

function payrollPage(
  runId: string,
  lines: ReturnType<typeof line>[],
  options: { total?: number; limit?: number; offset?: number } = {},
) {
  return {
    data: {
      run: runs.find((run) => run.id === runId) ?? { ...runs[0], id: runId },
      legal_basis: {},
      source_summary: {},
      lines,
      lines_total: options.total ?? lines.length,
      lines_limit: options.limit ?? 500,
      lines_offset: options.offset ?? 0,
    },
  };
}

function setupApi(GET: ReturnType<typeof vi.fn>) {
  const POST = vi.fn(async (path: string) => {
    await Promise.resolve();
    if (path === "/api/v1/analytics/projection") return { data: projection };
    throw new Error(`unexpected POST ${path}`);
  });
  mockUseAuth.mockReturnValue({ api: { GET, POST }, session: { roles: ["ADMIN"] } });
  return { GET, POST };
}

function setupAuth() {
  const GET = vi.fn(async (path: string, opts?: GetOptions) => {
    await Promise.resolve();
    if (path === "/api/v1/payroll/runs") {
      return { data: { items: runs, total: runs.length, limit: 12, offset: 0 } };
    }
    if (path === "/api/v1/payroll/runs/{id}") {
      const id = opts?.params?.path?.id ?? "";
      return payrollPage(id, [line(`${id}-a`, runHours[id])]);
    }
    throw new Error(`unexpected GET ${path}`);
  });
  return setupApi(GET);
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
    expect(await screen.findByText(`360${S.hourUnit}`)).toBeVisible();

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

  it("loads detail data for every payroll run rendered from the 12-run list", async () => {
    const twelveRuns = Array.from({ length: 12 }, (_, index) => ({
      id: `run-${String(index + 1)}`,
      period_start: `2026-${String(index + 1).padStart(2, "0")}-01`,
      period_end: `2026-${String(index + 1).padStart(2, "0")}-28`,
      status: "APPROVED",
    }));
    const GET = vi.fn((path: string, opts?: GetOptions) => {
      if (path === "/api/v1/payroll/runs") {
        return { data: { items: twelveRuns, total: 12, limit: 12, offset: 0 } };
      }
      const id = opts?.params?.path?.id ?? "";
      return payrollPage(id, [line(`${id}-line`, [1, 0, 0, 0])]);
    });
    setupApi(GET);

    render(<LaborCostBody />);

    expect(await screen.findByText("2026-12-01")).toBeVisible();
    await waitFor(() => {
      const detailedRunIds = GET.mock.calls
        .filter(([path]) => path === "/api/v1/payroll/runs/{id}")
        .map(([, opts]) => (opts as GetOptions).params?.path?.id);
      expect(new Set(detailedRunIds)).toEqual(new Set(twelveRuns.map((run) => run.id)));
    }, { timeout: 1_000 });
    expect(await screen.findByText(`12${S.hourUnit}`)).toBeVisible();
  });

  it("paginates every payroll line through lines_total using the 500-line limit", async () => {
    const allLines = Array.from({ length: 1001 }, (_, index) =>
      line(`line-${String(index)}`, [1, 0, 0, 0]),
    );
    const offsets: number[] = [];
    const GET = vi.fn((path: string, opts?: GetOptions) => {
      if (path === "/api/v1/payroll/runs") {
        return { data: { items: [runs[0]], total: 1, limit: 12, offset: 0 } };
      }
      const offset = opts?.params?.query?.offset ?? 0;
      offsets.push(offset);
      return payrollPage("r3", allLines.slice(offset, offset + 500), {
        total: allLines.length,
        limit: 500,
        offset,
      });
    });
    setupApi(GET);

    render(<LaborCostBody />);

    await waitFor(() => {
      expect(screen.getByText(`1001${S.hourUnit}`)).toBeVisible();
    }, { timeout: 1_000 });
    expect(offsets).toEqual([0, 500, 1000]);
  });

  it("shows a distinct full-list alert and retries the complete load", async () => {
    const user = userEvent.setup();
    let listAttempts = 0;
    const GET = vi.fn((path: string, opts?: GetOptions) => {
      if (path === "/api/v1/payroll/runs") {
        listAttempts += 1;
        if (listAttempts === 1) throw new Error("runs unavailable");
        return { data: { items: runs, total: runs.length, limit: 12, offset: 0 } };
      }
      const id = opts?.params?.path?.id ?? "";
      return payrollPage(id, [line(`${id}-a`, runHours[id])]);
    });
    setupApi(GET);

    render(<LaborCostBody />);

    const alert = await waitFor(() => screen.getByRole("alert"), { timeout: 1_000 });
    expect(alert).toHaveTextContent(S.listError);
    expect(screen.queryByRole("region", { name: S.compositionTitle })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: S.retry }));

    expect(await screen.findByText(`360${S.hourUnit}`)).toBeVisible();
    expect(listAttempts).toBe(2);
    expect(
      GET.mock.calls.filter(([path]) => path === "/api/v1/payroll/runs/{id}"),
    ).toHaveLength(runs.length);
  });

  it("keeps period summaries but hides incomplete analytics when a detail page fails", async () => {
    const user = userEvent.setup();
    let listAttempts = 0;
    let failSecondPage = true;
    const GET = vi.fn((path: string, opts?: GetOptions) => {
      if (path === "/api/v1/payroll/runs") {
        listAttempts += 1;
        return { data: { items: runs, total: runs.length, limit: 12, offset: 0 } };
      }
      const id = opts?.params?.path?.id ?? "";
      const offset = opts?.params?.query?.offset ?? 0;
      if (id === "r3") {
        if (offset === 500 && failSecondPage) throw new Error("page unavailable");
        const count = offset === 0 ? 500 : 1;
        return payrollPage(
          id,
          Array.from({ length: count }, (_, index) =>
            line(`${id}-${String(offset + index)}`, [1, 0, 0, 0]),
          ),
          { total: 501, limit: 500, offset },
        );
      }
      return payrollPage(id, [line(`${id}-a`, runHours[id])]);
    });
    setupApi(GET);

    render(<LaborCostBody />);

    expect(await screen.findByText("2026-06-01")).toBeVisible();
    const alert = await waitFor(() => screen.getByRole("alert"), { timeout: 1_000 });
    expect(alert).toHaveTextContent(S.detailError);
    expect(screen.queryByRole("region", { name: S.compositionTitle })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: ko.console.charts.projection.title(S.trendTitle) }),
    ).not.toBeInTheDocument();

    failSecondPage = false;
    await user.click(screen.getByRole("button", { name: S.retry }));

    expect(await screen.findByText(`721${S.hourUnit}`)).toBeVisible();
    expect(listAttempts).toBe(2);
  });

  it.each([
    {
      name: "an empty page before lines_total is reached",
      page: payrollPage("r3", [], { total: 501, limit: 500, offset: 0 }),
    },
    {
      name: "page metadata that does not match the requested offset",
      page: payrollPage("r3", [line("r3-a", [1, 0, 0, 0])], {
        total: 1,
        limit: 500,
        offset: 25,
      }),
    },
  ])("fails closed without looping on $name", async ({ page }) => {
    const GET = vi.fn((path: string) => {
      if (path === "/api/v1/payroll/runs") {
        return { data: { items: [runs[0]], total: 1, limit: 12, offset: 0 } };
      }
      return page;
    });
    setupApi(GET);

    render(<LaborCostBody />);

    const alert = await waitFor(() => screen.getByRole("alert"), { timeout: 1_000 });
    expect(alert).toHaveTextContent(S.detailError);
    expect(
      GET.mock.calls.filter(([path]) => path === "/api/v1/payroll/runs/{id}"),
    ).toHaveLength(1);
  });

  it("fails closed when lines_total changes between pages", async () => {
    const GET = vi.fn((path: string, opts?: GetOptions) => {
      if (path === "/api/v1/payroll/runs") {
        return { data: { items: [runs[0]], total: 1, limit: 12, offset: 0 } };
      }
      const offset = opts?.params?.query?.offset ?? 0;
      const total = offset === 0 ? 501 : 502;
      const count = offset === 0 ? 500 : 2;
      return payrollPage(
        "r3",
        Array.from({ length: count }, (_, index) =>
          line(`r3-${String(offset + index)}`, [1, 0, 0, 0]),
        ),
        { total, limit: 500, offset },
      );
    });
    setupApi(GET);

    render(<LaborCostBody />);

    const alert = await waitFor(() => screen.getByRole("alert"), { timeout: 1_000 });
    expect(alert).toHaveTextContent(S.detailError);
    expect(
      GET.mock.calls.filter(([path]) => path === "/api/v1/payroll/runs/{id}"),
    ).toHaveLength(2);
  });

  it("clears stale composition and projection while a replacement load is pending", async () => {
    setupAuth();
    const view = render(<LaborCostBody />);
    expect(await screen.findByText(`360${S.hourUnit}`)).toBeVisible();
    expect(
      await screen.findByRole("region", {
        name: ko.console.charts.projection.title(S.trendTitle),
      }),
    ).toBeVisible();

    let resolveRuns: ((value: unknown) => void) | undefined;
    const pendingRuns = new Promise((resolve) => {
      resolveRuns = resolve;
    });
    const GET = vi.fn((path: string) => {
      if (path === "/api/v1/payroll/runs") return pendingRuns;
      throw new Error(`unexpected GET ${path}`);
    });
    setupApi(GET);
    view.rerender(<LaborCostBody />);

    try {
      await waitFor(() => {
        expect(screen.getByText(ko.common.loading)).toBeVisible();
      });
      expect(screen.queryByRole("region", { name: S.compositionTitle })).not.toBeInTheDocument();
      expect(
        screen.queryByRole("region", { name: ko.console.charts.projection.title(S.trendTitle) }),
      ).not.toBeInTheDocument();
    } finally {
      if (resolveRuns) {
        resolveRuns({ data: { items: [], total: 0, limit: 12, offset: 0 } });
      }
    }

    expect(await screen.findByText(S.emptyReason)).toBeVisible();
  });
});
