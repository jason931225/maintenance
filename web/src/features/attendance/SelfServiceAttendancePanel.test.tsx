import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SelfServiceAttendancePanel } from "./SelfServiceAttendancePanel";
import type { SelfServiceAttendanceApi } from "./selfServiceAttendanceApi";

const item = { id: "private-id", code: "AT-1", kind: "LATE" as const, status: "OPEN" as const, work_date: "2026-07-12", occurred_at: "2026-07-12T09:02:00+09:00", detail: "출근 기록 확인 필요" };
const page = { items: [item], total: 1, limit: 50, offset: 0 };
const linked = { status: "available" as const, projection: { week_start: "2026-07-06", current_hours: 38, projected_hours: 46, limit_hours: 52, tone: "WARN" as const } };

function deferred<T>() { let resolve: (value: T) => void = () => undefined; let reject: (value?: unknown) => void = () => undefined; const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no; }); return { promise, resolve, reject }; }
function api(overrides: Partial<SelfServiceAttendanceApi> = {}): SelfServiceAttendanceApi {
  return { listOwnExceptions: vi.fn().mockResolvedValue(page), getOwnWeek52: vi.fn().mockResolvedValue(linked), ...overrides };
}
function renderPanel(value = api(), active = true, sessionIdentity = "session-a") {
  return { value, ...render(<SelfServiceAttendancePanel api={value} active={active} sessionIdentity={sessionIdentity} now={() => new Date("2026-07-24T12:00:00Z")} />) };
}

describe("SelfServiceAttendancePanel", () => {
  it("starts OPEN/current month and reads both own resources in parallel without authority selectors", async () => {
    const value = api(); renderPanel(value);
    // The API port intentionally declares callable methods rather than test spies.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    await waitFor(() => { expect(value.listOwnExceptions).toHaveBeenCalledWith({ month: "2026-07", status: "OPEN", limit: 50, offset: 0 }, expect.any(AbortSignal)); });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(value.getOwnWeek52).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(screen.getByRole("button", { name: /출근 기록 확인 필요/ })).toBeVisible();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const request = vi.mocked(value.listOwnExceptions).mock.calls[0][0] as Record<string, unknown>;
    ["branch_id", "employee_id", "actor_id", "manager_id"].forEach((key) => { expect(request).not.toHaveProperty(key); });
  });

  it("distinguishes linked zero hours from unavailable linkage", async () => {
    const zero = api({ getOwnWeek52: vi.fn().mockResolvedValue({ status: "available", projection: { ...linked.projection, current_hours: 0, projected_hours: 0, tone: "OK" } }) });
    const { rerender } = renderPanel(zero);
    expect(await screen.findByText("0.0시간")).toBeVisible();
    const unavailable = api({ getOwnWeek52: vi.fn().mockResolvedValue({ status: "not_available" }) });
    rerender(<SelfServiceAttendancePanel api={unavailable} active sessionIdentity="session-b" now={() => new Date("2026-07-24T12:00:00Z")} />);
    expect(await screen.findByText("현재 주간 근태 집계가 연결되지 않았습니다.")).toBeVisible();
  });

  it("preserves a ready exceptions panel when Week52 fails and retries only that panel", async () => {
    const getOwnWeek52 = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(linked);
    const value = api({ getOwnWeek52 }); renderPanel(value);
    expect(await screen.findByRole("button", { name: /출근 기록 확인 필요/ })).toBeVisible();
    const alerts = await screen.findAllByRole("alert");
    await userEvent.click(within(alerts[0]).getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("38.0시간")).toBeVisible();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(value.listOwnExceptions).toHaveBeenCalledTimes(1);
  });

  it("aborts stale own-exception reads on filter/month/page changes and uses server paging", async () => {
    const first = deferred<typeof page>(); let firstSignal: AbortSignal | undefined; let requestCount = 0;
    const listOwnExceptions = vi.fn((query: { offset: number }, nextSignal?: AbortSignal) => {
      requestCount += 1;
      if (requestCount === 1) firstSignal = nextSignal;
      return requestCount === 1 ? first.promise : Promise.resolve({ ...page, offset: query.offset, total: 51 });
    });
    const value = api({ listOwnExceptions }); renderPanel(value);
    await waitFor(() => { expect(firstSignal).toBeDefined(); });
    await userEvent.selectOptions(screen.getByLabelText("상태"), "RESOLVED");
    await waitFor(() => { expect(firstSignal?.aborted).toBe(true); });
    first.resolve(page);
    await waitFor(() => { expect(listOwnExceptions).toHaveBeenLastCalledWith({ month: "2026-07", status: "RESOLVED", limit: 50, offset: 0 }, expect.any(AbortSignal)); });
    await userEvent.click(await screen.findByRole("button", { name: "다음" }));
    await waitFor(() => { expect(listOwnExceptions).toHaveBeenLastCalledWith({ month: "2026-07", status: "RESOLVED", limit: 50, offset: 50 }, expect.any(AbortSignal)); });
    fireEvent.change(screen.getByLabelText("대상 월"), { target: { value: "2026-06" } });
    await waitFor(() => { expect(listOwnExceptions).toHaveBeenLastCalledWith({ month: "2026-06", status: "RESOLVED", limit: 50, offset: 0 }, expect.any(AbortSignal)); });
  });

  it("fences state at session identity, respects inactive mounts, and supports keyboard dialog focus return", async () => {
    const value = api(); const { rerender } = renderPanel(value, false);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(value.listOwnExceptions).not.toHaveBeenCalled();
    rerender(<SelfServiceAttendancePanel api={value} active sessionIdentity="session-a" now={() => new Date("2026-07-24T12:00:00Z")} />);
    const row = await screen.findByRole("button", { name: /출근 기록 확인 필요/ });
    row.focus(); await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "예외 상세" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => { expect(screen.queryByRole("dialog")).toBeNull(); });
    expect(row).toHaveFocus();
  });

  it("fails closed for a status/projection mismatch and never renders ids or manager controls", async () => {
    const value = api({ getOwnWeek52: vi.fn().mockResolvedValue({ status: "not_available", projection: linked.projection }) }); renderPanel(value);
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.queryByText("private-id")).toBeNull();
    expect(screen.queryByRole("button", { name: /대근|마감|승인|배정/ })).toBeNull();
  });
});
