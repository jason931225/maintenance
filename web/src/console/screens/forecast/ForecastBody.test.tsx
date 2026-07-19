import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AssetLifecycleCostSummary, EquipmentListItem } from "../../../api/types";
import { formatWon } from "../../charts";
import { forecastStrings } from "../../forecast";
import { ForecastBody } from "./ForecastBody";

const S = forecastStrings();

// useNavigate is the only router surface ForecastBody touches — mock it so drill
// navigation is observable without a router provider.
const navigateSpy = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateSpy,
}));

// useAuth is mocked so the body's self-fetch runs against a spied api client.
const mockUseAuth = vi.fn();
vi.mock("../../../context/auth", () => ({
  useAuth: () => mockUseAuth() as unknown,
}));

const equipment: EquipmentListItem = {
  equipment_id: "aaaa1111-bbbb-2222-cccc-333344445555",
  branch_id: "00000000-0000-4000-8000-000000000009",
  equipment_no: "FL-0042",
  status: "rented",
  specification: "3T forklift",
  ton_text: "3T",
  customer_name: "Donghae",
  site_name: "Changwon",
  updated_at: "2026-07-01T00:00:00Z",
};

const otherEquipment: EquipmentListItem = {
  ...equipment,
  equipment_id: "bbbb2222-cccc-3333-dddd-444455556666",
  equipment_no: "FL-0043",
  customer_name: "Namhae",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** First-of-month at noon UTC, `monthsAgo` months back — safely inside the
 *  trailing window and strictly in the past regardless of the run date. */
function monthEntryAt(monthsAgo: number): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1, 12),
  ).toISOString();
}

// Three distinct recent months → a real sample of length 3 (min the backend needs).
const lifecycleCost: AssetLifecycleCostSummary = {
  equipment_id: equipment.equipment_id,
  equipment_no: equipment.equipment_no,
  status: "rented",
  acquisition_source: "EXPLICIT",
  maintenance_total_won: 1_200_000,
  manual_total_won: 0,
  purchase_total_won: 0,
  entry_count: 3,
  residual_value_won: 0,
  tco_won: 1_200_000,
  timeline: [1, 2, 3].map((monthsAgo) => ({
    id: `e${String(monthsAgo)}`,
    branch_id: equipment.branch_id,
    equipment_id: equipment.equipment_id,
    source: "MAINTENANCE",
    amount_won: monthsAgo * 100_000,
    memo: "",
    residual_before_won: 0,
    residual_after_won: 0,
    entry_at: monthEntryAt(monthsAgo),
  })),
};

const projection = {
  point_estimate: 550_000,
  ci95_low: 400_000,
  ci95_high: 700_000,
  cvar95: 320_000,
  assumptions: {
    ewma_volatility: 90_000,
    student_t_nu: 4,
    drift: 1_000,
    simulations: 20_000,
    seed: 42,
  },
};

interface Spies {
  GET: ReturnType<typeof vi.fn>;
  POST: ReturnType<typeof vi.fn>;
}

function setupAuth(): Spies {
  const GET = vi.fn(async (path: string) => {
    await Promise.resolve();
    if (path === "/api/v1/equipment/list") {
      return { data: { items: [equipment], total: 1, limit: 20, offset: 0 } };
    }
    if (path === "/api/v1/financial/equipment/{equipmentId}/lifecycle-cost") {
      return { data: lifecycleCost };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  const POST = vi.fn(async (path: string) => {
    await Promise.resolve();
    if (path === "/api/v1/analytics/projection") {
      return { data: projection };
    }
    throw new Error(`unexpected POST ${path}`);
  });
  mockUseAuth.mockReturnValue({ api: { GET, POST }, session: { roles: ["ADMIN"] } });
  return { GET, POST };
}

afterEach(() => {
  mockUseAuth.mockReset();
  navigateSpy.mockReset();
});

describe("ForecastBody", () => {
  it("searches equipment, loads the real cost ledger, and projects it via the backend", async () => {
    const { POST } = setupAuth();
    const user = userEvent.setup();
    render(<ForecastBody />);

    await user.type(screen.getByRole("searchbox"), "FL-0042");

    const result = await screen.findByRole("button", { name: /FL-0042/ });
    await user.click(result);

    // Backend projection fired over the real cost sample, oldest month first
    // (the entry 3 months ago is ₩300k, 2 months ago ₩200k, last month ₩100k).
    await waitFor(() => {
      expect(POST).toHaveBeenCalledWith("/api/v1/analytics/projection", {
        body: { series: [300_000, 200_000, 100_000], horizon: 6, kind: "money" },
      });
    });

    // The panel surfaces the backend point estimate (not the client fallback).
    expect(await screen.findByText(formatWon(projection.point_estimate))).toBeVisible();
  });

  it("drills a projection stat to the source equipment", async () => {
    setupAuth();
    const user = userEvent.setup();
    render(<ForecastBody />);

    await user.type(screen.getByRole("searchbox"), "FL-0042");
    await user.click(await screen.findByRole("button", { name: /FL-0042/ }));
    await screen.findByText(formatWon(projection.point_estimate));

    await user.click(screen.getByRole("button", { name: /₩550,000/ }));
    expect(navigateSpy).toHaveBeenCalledWith("/equipment");
  });

  it("ignores a lifecycle response after the selected equipment is cleared", async () => {
    const lifecycle = deferred<{ data: AssetLifecycleCostSummary }>();
    const POST = vi.fn().mockResolvedValue({ data: projection });
    const GET = vi.fn((path: string) => {
      if (path === "/api/v1/equipment/list") {
        return Promise.resolve({ data: { items: [equipment], total: 1, limit: 20, offset: 0 } });
      }
      if (path === "/api/v1/financial/equipment/{equipmentId}/lifecycle-cost") {
        return lifecycle.promise;
      }
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    mockUseAuth.mockReturnValue({ api: { GET, POST }, session: { roles: ["ADMIN"] } });
    const user = userEvent.setup();
    render(<ForecastBody />);

    await user.type(screen.getByRole("searchbox"), equipment.equipment_no);
    await user.click(await screen.findByRole("button", { name: /FL-0042/ }));
    await user.click(screen.getByRole("button", { name: S.changeEquipment }));

    lifecycle.resolve({ data: lifecycleCost });
    await waitFor(() => {
      expect(screen.getByRole("searchbox")).toBeVisible();
      expect(POST).not.toHaveBeenCalled();
    });
  });

  it("hides the previous backend projection while a changed horizon is pending", async () => {
    const nextProjection = deferred<{ data: typeof projection }>();
    let projectionCall = 0;
    const GET = vi.fn((path: string) => {
      if (path === "/api/v1/equipment/list") {
        return Promise.resolve({
          data: { items: [equipment, otherEquipment], total: 2, limit: 20, offset: 0 },
        });
      }
      if (path === "/api/v1/financial/equipment/{equipmentId}/lifecycle-cost") {
        return Promise.resolve({ data: lifecycleCost });
      }
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    const POST = vi.fn(() => {
      projectionCall += 1;
      return projectionCall === 1 ? Promise.resolve({ data: projection }) : nextProjection.promise;
    });
    mockUseAuth.mockReturnValue({ api: { GET, POST }, session: { roles: ["ADMIN"] } });
    const user = userEvent.setup();
    render(<ForecastBody />);

    await user.type(screen.getByRole("searchbox"), equipment.equipment_no);
    await user.click(await screen.findByRole("button", { name: /FL-0042/ }));
    expect(await screen.findByText(formatWon(projection.point_estimate))).toBeVisible();

    await user.click(screen.getByRole("button", { name: S.horizonMonths(12) }));
    await waitFor(() => {
      expect(POST).toHaveBeenCalledTimes(2);
      expect(screen.queryByText(formatWon(projection.point_estimate))).not.toBeInTheDocument();
    });

    nextProjection.resolve({ data: { ...projection, point_estimate: 650_000 } });
    expect(await screen.findByText(formatWon(650_000))).toBeVisible();
  });

  it("synchronously withholds prior-api equipment and projection state", async () => {
    setupAuth();
    const user = userEvent.setup();
    const view = render(<ForecastBody />);

    await user.type(screen.getByRole("searchbox"), equipment.equipment_no);
    await user.click(await screen.findByRole("button", { name: /FL-0042/ }));
    expect(await screen.findByText(formatWon(projection.point_estimate))).toBeVisible();

    const apiB = {
      GET: vi.fn(() => new Promise<never>(() => undefined)),
      POST: vi.fn(() => new Promise<never>(() => undefined)),
    };
    mockUseAuth.mockReturnValue({ api: apiB, session: { roles: ["ADMIN"] } });
    view.rerender(<ForecastBody />);

    expect(screen.getByRole("searchbox")).toBeVisible();
    expect(screen.queryByText(formatWon(projection.point_estimate))).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: S.changeEquipment })).not.toBeInTheDocument();
  });

  it("rejects an old-api lifecycle response before it can reach the new projection api", async () => {
    const lifecycle = deferred<{ data: AssetLifecycleCostSummary }>();
    const apiAPost = vi.fn().mockResolvedValue({ data: projection });
    const apiAGet = vi.fn((path: string) => {
      if (path === "/api/v1/equipment/list") {
        return Promise.resolve({ data: { items: [equipment], total: 1, limit: 20, offset: 0 } });
      }
      if (path === "/api/v1/financial/equipment/{equipmentId}/lifecycle-cost") {
        return lifecycle.promise;
      }
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    mockUseAuth.mockReturnValue({
      api: { GET: apiAGet, POST: apiAPost },
      session: { roles: ["ADMIN"] },
    });
    const user = userEvent.setup();
    const view = render(<ForecastBody />);

    await user.type(screen.getByRole("searchbox"), equipment.equipment_no);
    await user.click(await screen.findByRole("button", { name: /FL-0042/ }));

    const apiBPost = vi.fn().mockResolvedValue({ data: projection });
    const apiBGet = vi.fn().mockResolvedValue({
      data: { items: [], total: 0, limit: 20, offset: 0 },
    });
    mockUseAuth.mockReturnValue({
      api: { GET: apiBGet, POST: apiBPost },
      session: { roles: ["ADMIN"] },
    });
    view.rerender(<ForecastBody />);

    await act(async () => {
      lifecycle.resolve({ data: lifecycleCost });
      await lifecycle.promise;
    });

    expect(apiAPost).not.toHaveBeenCalled();
    expect(apiBPost).not.toHaveBeenCalled();
  });
});
