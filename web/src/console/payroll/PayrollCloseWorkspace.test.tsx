import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { PayrollCloseWorkspace } from "./PayrollCloseWorkspace";

const run = {
  id: "00000000-0000-4000-8000-000000000001",
  period_start: "2026-06-01",
  period_end: "2026-06-30",
  source_label: "2026년 6월 정기 지급",
  status: "READY_FOR_REVIEW" as const,
  calculation_enabled: true,
  created_by: null,
  approved_by: null,
  approved_at: null,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-02T00:00:00Z",
};

function detail(lines = [
  {
    id: "00000000-0000-4000-8000-000000000010",
    employee_id: "00000000-0000-4000-8000-000000000011",
    employee_display_name: "김가을",
    employee_company: "코스",
    work_days: 20,
    regular_hours: 160,
    overtime_hours: 8,
    night_hours: 0,
    holiday_hours: 0,
    leave_used: 1,
    leave_remaining: 12,
    gross_pay_source_present: true,
    net_pay_source_present: true,
    nts_tax_row_status: "VERIFIED_SOURCE_ROW" as const,
    calculation_status: "READY_FOR_REVIEW" as const,
    blockers: [],
  },
]) {
  return {
    run,
    legal_basis: { payroll_period: "2026-06" },
    source_summary: { attendance: "verified" },
    lines,
    lines_total: lines.length,
    lines_limit: 500,
    lines_offset: 0,
  };
}

function response(data?: unknown, status = 200) {
  return { data, response: new Response(null, { status }) };
}

function apiFor(get: ReturnType<typeof vi.fn>) {
  return { GET: get } as unknown as ConsoleApiClient;
}

function renderWorkspace(api: ConsoleApiClient) {
  return render(<PayrollCloseWorkspace api={api} />);
}

afterEach(() => vi.restoreAllMocks());

describe("PayrollCloseWorkspace", () => {
  it("loads an audited run list and opens its real readiness lines with keyboard", async () => {
    const get = vi.fn((path: string) =>
      path === "/api/v1/payroll/runs"
        ? Promise.resolve(response({ items: [run], total: 1, limit: 50, offset: 0 }))
        : Promise.resolve(response(detail())),
    );
    const user = userEvent.setup();
    renderWorkspace(apiFor(get));

    const row = await screen.findByRole("button", { name: /2026년 6월 정기 지급.*검토 대기/i });
    row.focus();
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("heading", { name: "급여 회차 상세" })).toBeVisible();
    expect(screen.getByText("김가을")).toBeVisible();
    expect(screen.getByText("160.0시간")).toBeVisible();
    expect(screen.getByText("확인된 원천 행")).toBeVisible();
    expect(get).toHaveBeenCalledWith("/api/v1/payroll/runs/{id}", expect.objectContaining({
      params: { path: { id: run.id }, query: { limit: 500, offset: 0 } },
    }));
  });

  it("states an empty close queue truthfully", async () => {
    const get = vi.fn(() => Promise.resolve(response({ items: [], total: 0, limit: 50, offset: 0 })));
    renderWorkspace(apiFor(get));
    expect(await screen.findByText("현재 조회 가능한 급여 회차가 없습니다.")).toBeVisible();
  });

  it("states a selected run with no readable employee lines truthfully", async () => {
    const get = vi.fn((path: string) =>
      path === "/api/v1/payroll/runs"
        ? Promise.resolve(response({ items: [run], total: 1, limit: 50, offset: 0 }))
        : Promise.resolve(response(detail([]))),
    );
    const user = userEvent.setup();
    renderWorkspace(apiFor(get));
    await user.click(await screen.findByRole("button", { name: /2026년 6월 정기 지급/i }));
    expect(await screen.findByText("이 회차에는 현재 조회 가능한 직원별 급여 준비 행이 없습니다.")).toBeVisible();
  });

  it("offers retry after a network failure while loading the run list", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue(response({ items: [], total: 0, limit: 50, offset: 0 }));
    const user = userEvent.setup();
    renderWorkspace(apiFor(get));
    expect(await screen.findByRole("alert")).toHaveTextContent("급여 회차 명부를 불러오지 못했습니다.");
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("현재 조회 가능한 급여 회차가 없습니다.")).toBeVisible();
  });

  it("fails closed when the audited run list is denied", async () => {
    const get = vi.fn(() => Promise.resolve(response(undefined, 403)));
    renderWorkspace(apiFor(get));
    expect(await screen.findByRole("alert")).toHaveTextContent("급여 회차 명부 열람 권한이 없습니다.");
    expect(screen.queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();
  });

  it("keeps the run list and lets the user retry only a transient detail failure", async () => {
    let attempts = 0;
    const get = vi.fn((path: string) => {
      if (path === "/api/v1/payroll/runs") {
        return Promise.resolve(response({ items: [run], total: 1, limit: 50, offset: 0 }));
      }
      attempts += 1;
      return Promise.resolve(attempts === 1 ? response(undefined, 500) : response(detail()));
    });
    const user = userEvent.setup();
    renderWorkspace(apiFor(get));
    const row = await screen.findByRole("button", { name: /2026년 6월 정기 지급/i });
    await user.click(row);
    expect(await screen.findByRole("alert")).toHaveTextContent("급여 회차 상세를 불러오지 못했습니다.");
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("김가을")).toBeVisible();
  });
});
