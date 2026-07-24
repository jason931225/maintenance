import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { ko } from "../../i18n/ko";
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

function detail(
  lines = [
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
  ],
) {
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

function renderWorkspace(
  api: ConsoleApiClient,
  authorityKey = "token-a:incarnation-a",
) {
  return render(
    <PayrollCloseWorkspace api={api} authorityKey={authorityKey} />,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("PayrollCloseWorkspace", () => {
  it("uses the Korean catalog for audited close status and hour formatters", () => {
    const copy = ko.payroll.closeWorkspace;
    expect(copy.statuses.READY_FOR_REVIEW).toBe("검토 대기");
    expect(copy.hours.value(1.5)).toBe("1.5시간");
    expect(
      copy.list.detailAria("2026년 6월", copy.statuses.READY_FOR_REVIEW),
    ).toBe("2026년 6월 검토 대기 상세 열기");
  });

  it("loads an audited run list and opens its real readiness lines with keyboard", async () => {
    const get = vi.fn((path: string) =>
      path === "/api/v1/payroll/runs"
        ? Promise.resolve(
            response({ items: [run], total: 1, limit: 50, offset: 0 }),
          )
        : Promise.resolve(response(detail())),
    );
    const user = userEvent.setup();
    renderWorkspace(apiFor(get));

    const row = await screen.findByRole("button", {
      name: /2026년 6월 정기 지급.*검토 대기/i,
    });
    row.focus();
    await user.keyboard("{Enter}");

    expect(
      await screen.findByRole("heading", { name: "급여 회차 상세" }),
    ).toBeVisible();
    expect(screen.getByText("김가을")).toBeVisible();
    expect(screen.getByText("160.0시간")).toBeVisible();
    expect(screen.getByText("확인된 원천 행")).toBeVisible();
    expect(get).toHaveBeenCalledWith(
      "/api/v1/payroll/runs/{id}",
      expect.objectContaining({
        params: { path: { id: run.id }, query: { limit: 500, offset: 0 } },
      }),
    );
  });

  it("states an empty close queue truthfully", async () => {
    const get = vi.fn(() =>
      Promise.resolve(response({ items: [], total: 0, limit: 50, offset: 0 })),
    );
    renderWorkspace(apiFor(get));
    expect(
      await screen.findByText("현재 조회 가능한 급여 회차가 없습니다."),
    ).toBeVisible();
  });

  it("accepts omitted optional regular and overtime hours as unavailable values", async () => {
    const lineWithoutHours = { ...detail().lines[0] };
    delete lineWithoutHours.regular_hours;
    delete lineWithoutHours.overtime_hours;
    const get = vi.fn((path: string) =>
      Promise.resolve(
        path === "/api/v1/payroll/runs"
          ? response({ items: [run], total: 1, limit: 50, offset: 0 })
          : response(detail([lineWithoutHours])),
      ),
    );
    const user = userEvent.setup();
    renderWorkspace(apiFor(get));
    await user.click(
      await screen.findByRole("button", { name: /2026년 6월 정기 지급/i }),
    );
    expect(await screen.findByText("김가을")).toBeVisible();
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("states a selected run with no readable employee lines truthfully", async () => {
    const get = vi.fn((path: string) =>
      path === "/api/v1/payroll/runs"
        ? Promise.resolve(
            response({ items: [run], total: 1, limit: 50, offset: 0 }),
          )
        : Promise.resolve(response(detail([]))),
    );
    const user = userEvent.setup();
    renderWorkspace(apiFor(get));
    await user.click(
      await screen.findByRole("button", { name: /2026년 6월 정기 지급/i }),
    );
    expect(
      await screen.findByText(
        "이 회차에는 현재 조회 가능한 직원별 급여 준비 행이 없습니다.",
      ),
    ).toBeVisible();
  });

  it("offers retry after a network failure while loading the run list", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue(
        response({ items: [], total: 0, limit: 50, offset: 0 }),
      );
    const user = userEvent.setup();
    renderWorkspace(apiFor(get));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "급여 회차 명부를 불러오지 못했습니다.",
    );
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(
      await screen.findByText("현재 조회 가능한 급여 회차가 없습니다."),
    ).toBeVisible();
  });

  it("fails closed when the audited run list is denied", async () => {
    const get = vi.fn(() => Promise.resolve(response(undefined, 403)));
    renderWorkspace(apiFor(get));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "급여 회차 명부 열람 권한이 없습니다.",
    );
    expect(
      screen.queryByRole("button", { name: "다시 시도" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the run list and lets the user retry only a transient detail failure", async () => {
    let attempts = 0;
    const get = vi.fn((path: string) => {
      if (path === "/api/v1/payroll/runs") {
        return Promise.resolve(
          response({ items: [run], total: 1, limit: 50, offset: 0 }),
        );
      }
      attempts += 1;
      return Promise.resolve(
        attempts === 1 ? response(undefined, 500) : response(detail()),
      );
    });
    const user = userEvent.setup();
    renderWorkspace(apiFor(get));
    const row = await screen.findByRole("button", {
      name: /2026년 6월 정기 지급/i,
    });
    await user.click(row);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "급여 회차 상세를 불러오지 못했습니다.",
    );
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("김가을")).toBeVisible();
  });
});

describe("PayrollCloseWorkspace transport integrity", () => {
  it("reaches every bounded run and detail page without claiming the first page is complete", async () => {
    const runB = {
      ...run,
      id: "00000000-0000-4000-8000-000000000002",
      source_label: "2026년 5월 정기 지급",
      period_start: "2026-05-01",
      period_end: "2026-05-31",
    };
    const secondLine = {
      ...detail().lines[0],
      id: "00000000-0000-4000-8000-000000000012",
      employee_display_name: "이봄",
    };
    const get = vi.fn(
      (
        path: string,
        options?: { params?: { query?: { offset?: number } } },
      ) => {
        const offset = options?.params?.query?.offset ?? 0;
        if (path === "/api/v1/payroll/runs") {
          return Promise.resolve(
            response(
              offset === 0
                ? { items: [run], total: 2, limit: 50, offset: 0 }
                : { items: [runB], total: 2, limit: 50, offset: 1 },
            ),
          );
        }
        return Promise.resolve(
          response(
            offset === 0
              ? {
                  ...detail(),
                  lines_total: 2,
                  lines_limit: 500,
                  lines_offset: 0,
                }
              : {
                  ...detail([secondLine]),
                  lines_total: 2,
                  lines_limit: 500,
                  lines_offset: 1,
                },
          ),
        );
      },
    );
    const user = userEvent.setup();
    renderWorkspace(apiFor(get));
    expect(await screen.findByText("2026년 6월 정기 지급")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "회차 더 불러오기" }));
    expect(await screen.findByText("2026년 5월 정기 지급")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: /2026년 6월 정기 지급/i }),
    );
    expect(await screen.findByText("김가을")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "직원 행 더 불러오기" }),
    );
    expect(await screen.findByText("이봄")).toBeVisible();
  });

  it("fails the page closed when list metadata does not match the bounded request", async () => {
    const get = vi.fn(() =>
      Promise.resolve(
        response({ items: [run], total: 1, limit: 100, offset: 0 }),
      ),
    );
    renderWorkspace(apiFor(get));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "급여 회차 명부를 불러오지 못했습니다.",
    );
  });

  it("partitions pending reads by authority token and incarnation", async () => {
    let resolveOld!: (value: ReturnType<typeof response>) => void;
    const oldRead = new Promise<ReturnType<typeof response>>((resolve) => {
      resolveOld = resolve;
    });
    const oldApi = apiFor(vi.fn(() => oldRead));
    const newerRun = { ...run, source_label: "새 권한 회차" };
    const newApi = apiFor(
      vi.fn(() =>
        Promise.resolve(
          response({ items: [newerRun], total: 1, limit: 50, offset: 0 }),
        ),
      ),
    );
    const view = renderWorkspace(oldApi, "token-a:incarnation-a");
    view.rerender(
      <PayrollCloseWorkspace
        api={newApi}
        authorityKey="token-b:incarnation-b"
      />,
    );
    expect(await screen.findByText("새 권한 회차")).toBeVisible();
    resolveOld(response({ items: [run], total: 1, limit: 50, offset: 0 }));
    await Promise.resolve();
    expect(screen.queryByText("2026년 6월 정기 지급")).not.toBeInTheDocument();
  });

  it("fails closed when a later run page drifts in total or repeats an id", async () => {
    const get = vi.fn(
      (path: string, options?: { params?: { query?: { offset?: number } } }) =>
        Promise.resolve(
          response(
            path === "/api/v1/payroll/runs" &&
              options?.params?.query?.offset === 0
              ? { items: [run], total: 2, limit: 50, offset: 0 }
              : { items: [run], total: 3, limit: 50, offset: 1 },
          ),
        ),
    );
    const user = userEvent.setup();
    renderWorkspace(apiFor(get));
    await user.click(
      await screen.findByRole("button", { name: "회차 더 불러오기" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "급여 회차 명부를 불러오지 못했습니다.",
    );
  });

  it("fails closed when a later detail page drifts in total or repeats an id", async () => {
    const get = vi.fn(
      (
        path: string,
        options?: { params?: { query?: { offset?: number } } },
      ) => {
        if (path === "/api/v1/payroll/runs") {
          return Promise.resolve(
            response({ items: [run], total: 1, limit: 50, offset: 0 }),
          );
        }
        return Promise.resolve(
          response(
            options?.params?.query?.offset === 0
              ? { ...detail(), lines_total: 2 }
              : { ...detail(), lines_total: 3, lines_offset: 1 },
          ),
        );
      },
    );
    const user = userEvent.setup();
    renderWorkspace(apiFor(get));
    await user.click(
      await screen.findByRole("button", { name: /2026년 6월 정기 지급/i }),
    );
    await user.click(
      await screen.findByRole("button", { name: "직원 행 더 불러오기" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "급여 회차 상세를 불러오지 못했습니다.",
    );
  });

  it("fails closed when a later run page repeats an id without changing total", async () => {
    const get = vi.fn(
      (path: string, options?: { params?: { query?: { offset?: number } } }) =>
        Promise.resolve(
          response(
            path === "/api/v1/payroll/runs" &&
              options?.params?.query?.offset === 0
              ? { items: [run], total: 2, limit: 50, offset: 0 }
              : { items: [run], total: 2, limit: 50, offset: 1 },
          ),
        ),
    );
    const user = userEvent.setup();
    renderWorkspace(apiFor(get));
    await user.click(
      await screen.findByRole("button", { name: "회차 더 불러오기" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "급여 회차 명부를 불러오지 못했습니다.",
    );
  });

  it("fails closed when a later detail page repeats an id without changing total", async () => {
    const get = vi.fn(
      (
        path: string,
        options?: { params?: { query?: { offset?: number } } },
      ) => {
        if (path === "/api/v1/payroll/runs")
          return Promise.resolve(
            response({ items: [run], total: 1, limit: 50, offset: 0 }),
          );
        return Promise.resolve(
          response(
            options?.params?.query?.offset === 0
              ? { ...detail(), lines_total: 2 }
              : { ...detail(), lines_total: 2, lines_offset: 1 },
          ),
        );
      },
    );
    const user = userEvent.setup();
    renderWorkspace(apiFor(get));
    await user.click(
      await screen.findByRole("button", { name: /2026년 6월 정기 지급/i }),
    );
    await user.click(
      await screen.findByRole("button", { name: "직원 행 더 불러오기" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "급여 회차 상세를 불러오지 못했습니다.",
    );
  });

  it("fails closed when a later run page makes no progress", async () => {
    const get = vi.fn(
      (path: string, options?: { params?: { query?: { offset?: number } } }) =>
        Promise.resolve(
          response(
            path === "/api/v1/payroll/runs" &&
              options?.params?.query?.offset === 0
              ? { items: [run], total: 2, limit: 50, offset: 0 }
              : { items: [], total: 2, limit: 50, offset: 1 },
          ),
        ),
    );
    const user = userEvent.setup();
    renderWorkspace(apiFor(get));
    await user.click(
      await screen.findByRole("button", { name: "회차 더 불러오기" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "급여 회차 명부를 불러오지 못했습니다.",
    );
  });

  it("fails closed when a later detail page makes no progress", async () => {
    const get = vi.fn(
      (
        path: string,
        options?: { params?: { query?: { offset?: number } } },
      ) => {
        if (path === "/api/v1/payroll/runs")
          return Promise.resolve(
            response({ items: [run], total: 1, limit: 50, offset: 0 }),
          );
        return Promise.resolve(
          response(
            options?.params?.query?.offset === 0
              ? { ...detail(), lines_total: 2 }
              : { ...detail([]), lines_total: 2, lines_offset: 1 },
          ),
        );
      },
    );
    const user = userEvent.setup();
    renderWorkspace(apiFor(get));
    await user.click(
      await screen.findByRole("button", { name: /2026년 6월 정기 지급/i }),
    );
    await user.click(
      await screen.findByRole("button", { name: "직원 행 더 불러오기" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "급여 회차 상세를 불러오지 못했습니다.",
    );
  });

  it("rejects non-progress pages and malformed rendered tax or hour fields", async () => {
    const malformed = {
      ...detail([
        {
          ...detail().lines[0],
          nts_tax_row_status: "UNKNOWN",
          regular_hours: Infinity,
        },
      ]),
    };
    const get = vi.fn((path: string) =>
      Promise.resolve(
        path === "/api/v1/payroll/runs"
          ? response({ items: [run], total: 1, limit: 50, offset: 0 })
          : response(malformed),
      ),
    );
    const user = userEvent.setup();
    renderWorkspace(apiFor(get));
    await user.click(
      await screen.findByRole("button", { name: /2026년 6월 정기 지급/i }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "급여 회차 상세를 불러오지 못했습니다.",
    );
  });

  it("never commits an older run selection after a newer selection wins", async () => {
    let resolveA!: (value: ReturnType<typeof response>) => void;
    const firstDetail = new Promise<ReturnType<typeof response>>((resolve) => {
      resolveA = resolve;
    });
    const runB = {
      ...run,
      id: "00000000-0000-4000-8000-000000000002",
      source_label: "2026년 5월 정기 지급",
      period_start: "2026-05-01",
      period_end: "2026-05-31",
    };
    const get = vi.fn(
      (path: string, options?: { params?: { path?: { id?: string } } }) => {
        if (path === "/api/v1/payroll/runs")
          return Promise.resolve(
            response({ items: [run, runB], total: 2, limit: 50, offset: 0 }),
          );
        if (options?.params?.path?.id === run.id) return firstDetail;
        return Promise.resolve(
          response({
            ...detail([
              { ...detail().lines[0], employee_display_name: "최신 선택" },
            ]),
            run: runB,
          }),
        );
      },
    );
    const user = userEvent.setup();
    renderWorkspace(apiFor(get));
    await user.click(
      await screen.findByRole("button", { name: /2026년 6월 정기 지급/i }),
    );
    await user.click(
      screen.getByRole("button", { name: /2026년 5월 정기 지급/i }),
    );
    expect(await screen.findByText("최신 선택")).toBeVisible();
    resolveA(response(detail()));
    await Promise.resolve();
    expect(screen.queryByText("김가을")).not.toBeInTheDocument();
  });
});
